import WebSocket from 'ws';

/**
 * GeminiConnectionManager
 * 
 * Gestiona el ciclo de vida del WebSocket hacia Gemini Live (gemini-3.5-transcribe-live) en v1beta.
 * 
 * Responsabilidades:
 * 1. Handshake inicial con setup de transcripción (mode: SMART, customVocabulary).
 * 2. Streaming de chunks PCM 16kHz continuos.
 * 3. Procesamiento de interimInputTranscription (provisionales) e inputTranscription (finales autoritativos).
 * 4. Control de límite de 10 minutos con reconexión transparente (Session Resumption / GoAway).
 */
export class GeminiConnectionManager {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY;
    this.sessionId = options.sessionId || 'test';
    this.customVocabulary = options.customVocabulary || [
      'Nerdearla', 'Gemini', 'Kubernetes', 'TypeScript', 'React',
      'A-TEAM', 'Cloud Run', 'Firestore', 'Antigravity', 'Voicy'
    ];

    this.onInterim = options.onInterim || (() => {});
    this.onFinal = options.onFinal || (() => {});
    this.onError = options.onError || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});

    this.ws = null;
    this.isConnected = false;
    this.sessionHandle = null;
    this.sessionStartTime = null;

    // Timers
    this.maxDurationTimer = null;
    this.MAX_SESSION_DURATION_MS = 9 * 60 * 1000; // 9 minutos para prevenir el corte de 10 min

    // Backoff exponencial para quota errors (código 1011)
    this.retryDelay = 5000;  // 5s inicial
    this.MAX_RETRY_DELAY = 30000; // máximo 30s entre reintentos
  }

  async connect() {
    if (!this.apiKey) {
      const err = new Error('GEMINI_API_KEY no está configurada.');
      this.onError(err);
      throw err;
    }

    const host = 'generativelanguage.googleapis.com';
    // Se requiere v1beta para gemini-3.5-transcribe-live
    const path = `/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.apiKey}`;
    const uri = `wss://${host}${path}`;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(uri);

        this.ws.on('open', () => {
          console.log(`[GeminiLive:${this.sessionId}] Conectado a Gemini Live API (v1beta). Enviando Setup...`);
          this.sendSetup();
          this.isConnected = true;
          this.sessionStartTime = Date.now();
          this.scheduleSessionRenewal();
          this.onStatusChange('connected');
          resolve();
        });

        this.ws.on('message', (data) => {
          this.handleIncomingMessage(data);
        });

        this.ws.on('error', (err) => {
          console.error(`[GeminiLive:${this.sessionId}] Error en WebSocket:`, err.message);
          this.onError(err);
          this.onStatusChange('error');
        });

        this.ws.on('close', (code, reason) => {
          console.warn(`[GeminiLive:${this.sessionId}] Desconectado (código ${code}): ${reason}`);
          const isQuotaError = code === 1011;
          if (isQuotaError) {
            console.warn(`[GeminiLive:${this.sessionId}] ⚠️  QUOTA AGOTADA (free tier). Reintentando en ${this.retryDelay / 1000}s...`);
            this.onStatusChange('quota_error');
          } else {
            this.retryDelay = 5000; // reset backoff en desconexiones normales
          }
          this.cleanup();
          this.onStatusChange('disconnected');
          // Reconectar con delay (backoff si es quota, inmediato si es normal)
          const delay = isQuotaError ? this.retryDelay : 0;
          if (delay > 0) {
            this.retryDelay = Math.min(this.retryDelay * 2, this.MAX_RETRY_DELAY);
            setTimeout(() => this.reconnect(), delay);
          }
        });
      } catch (err) {
        this.cleanup();
        reject(err);
      }
    });
  }

  sendSetup() {
    const setupMsg = {
      setup: {
        model: 'models/gemini-3.5-transcribe-live',
        generationConfig: {
          responseModalities: ['TEXT']
        },
        inputAudioTranscription: {
          languageCodes: [], // Auto-detección multi-idioma continua según plan.md 4.2
          mode: 'SMART',     // Subtítulos limpios sin muletillas
          customVocabulary: this.customVocabulary
        }
      }
    };

    if (this.sessionHandle) {
      setupMsg.setup.sessionResumption = {
        sessionHandle: this.sessionHandle
      };
    }

    this.ws.send(JSON.stringify(setupMsg));
  }

  sendAudioChunk(pcmInt16Buffer) {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    const base64Audio = Buffer.from(pcmInt16Buffer).toString('base64');
    const audioMsg = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: 'audio/pcm;rate=16000',
            data: base64Audio
          }
        ]
      }
    };

    this.ws.send(JSON.stringify(audioMsg));
    return true;
  }

  handleIncomingMessage(rawData) {
    try {
      const payload = JSON.parse(rawData.toString());

      if (payload.error) {
        console.error(`[GeminiLive:${this.sessionId}] ❌ Error de Gemini Live:`, payload.error);
        this.onError(new Error(payload.error.message || JSON.stringify(payload.error)));
        return;
      }

      if (payload.setupComplete) {
        console.log(`[GeminiLive:${this.sessionId}] ✅ Setup confirmado por Gemini Live.`);
      }

      // 1. Guardar session handle si se entrega para resumption
      if (payload.sessionResumptionUpdate && payload.sessionResumptionUpdate.newHandle) {
        this.sessionHandle = payload.sessionResumptionUpdate.newHandle;
      } else if (payload.sessionHandle) {
        this.sessionHandle = payload.sessionHandle;
      }

      // 2. Manejo de GoAway (aviso de terminación preventiva de Google)
      if (payload.goAway) {
        console.warn(`[GeminiLive:${this.sessionId}] Recibido GoAway. Reconectando transparentemente...`);
        this.reconnect();
        return;
      }

      const serverContent = payload.serverContent;
      if (!serverContent) return;

      // 3. Interim transcription (texto parcial e incremental)
      if (serverContent.interimInputTranscription && serverContent.interimInputTranscription.text) {
        const text = serverContent.interimInputTranscription.text;
        console.log(`[GeminiLive:${this.sessionId}] 🎙️ Interim: "${text}"`);
        this.onInterim(text);
      }

      // 4. Input transcription (texto consolidado y definitivo)
      if (serverContent.inputTranscription && serverContent.inputTranscription.text) {
        const text = serverContent.inputTranscription.text;
        console.log(`[GeminiLive:${this.sessionId}] 🏁 Final: "${text}"`);
        this.onFinal(text);
      }
    } catch (err) {
      console.error(`[GeminiLive:${this.sessionId}] Error procesando mensaje de Gemini:`, err);
    }
  }

  scheduleSessionRenewal() {
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    // Programar reconexión transparente antes de llegar a los 10 minutos
    this.maxDurationTimer = setTimeout(() => {
      console.log(`[GeminiLive:${this.sessionId}] Renovando sesión de forma proactiva a los 9 minutos para prevenir límite de 10 min...`);
      this.reconnect();
    }, this.MAX_SESSION_DURATION_MS);
  }

  async reconnect() {
    this.cleanup();
    this.onStatusChange('reconnecting');
    try {
      await this.connect();
      console.log(`[GeminiLive:${this.sessionId}] Reconexión a Gemini exitosa.`);
    } catch (err) {
      console.error(`[GeminiLive:${this.sessionId}] Error en reconexión:`, err);
    }
  }

  cleanup() {
    this.isConnected = false;
    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
  }
}
