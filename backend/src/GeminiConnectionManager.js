import WebSocket from 'ws';

/**
 * GeminiConnectionManager
 * 
 * Gestiona el ciclo de vida del WebSocket hacia Gemini Live (gemini-3.5-transcribe-live).
 * 
 * Responsabilidades:
 * 1. Handshake inicial con setup de transcripción (mode: SMART, customVocabulary).
 * 2. Streaming de chunks PCM 16kHz continuos.
 * 3. Procesamiento de interimInputTranscription (provisionales) e inputTranscription (finales autoritativos).
 * 4. Control de límite de 10 minutos con reconexión transparente (Session Resumption / GoAway).
 * 5. Watchdog anti-freeze (detecta cuando hay audio continuo pero Gemini deja de responder).
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

    // Métricas del watchdog
    this.lastAudioSentAt = 0;
    this.lastGeminiMessageAt = 0;
    this.lastInterimAt = 0;
    this.lastFinalAt = 0;

    // Timers
    this.watchdogInterval = null;
    this.maxDurationTimer = null;
    this.MAX_SESSION_DURATION_MS = 9 * 60 * 1000; // 9 minutos (para prevenir el corte de 10 min)
  }

  async connect() {
    if (!this.apiKey) {
      const err = new Error('GEMINI_API_KEY no está configurada.');
      this.onError(err);
      throw err;
    }

    const host = 'generativelanguage.googleapis.com';
    const path = `/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${this.apiKey}`;
    const uri = `wss://${host}${path}`;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(uri);

        this.ws.on('open', () => {
          console.log(`[GeminiLive:${this.sessionId}] Conectado a Gemini Live API. Enviando Setup...`);
          this.sendSetup();
          this.isConnected = true;
          this.sessionStartTime = Date.now();
          this.lastGeminiMessageAt = Date.now();
          this.startWatchdog();
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
          this.cleanup();
          this.onStatusChange('disconnected');
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
          languageCodes: [], // Auto-detección multi-idioma continua
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
    this.lastAudioSentAt = Date.now();
    return true;
  }

  handleIncomingMessage(rawData) {
    try {
      this.lastGeminiMessageAt = Date.now();
      const payload = JSON.parse(rawData.toString());

      // 1. Guardar session handle si se entrega para resumption
      if (payload.sessionHandle) {
        this.sessionHandle = payload.sessionHandle;
      }

      // 2. Manejo de GoAway (aviso de terminación de Google)
      if (payload.goAway) {
        console.warn(`[GeminiLive:${this.sessionId}] Recibido mensaje GoAway. Preparando reconexión.`);
        this.reconnect();
        return;
      }

      const serverContent = payload.serverContent;
      if (!serverContent) return;

      // 3. Interim transcription (texto parcial e incremental)
      if (serverContent.interimInputTranscription && serverContent.interimInputTranscription.text) {
        const text = serverContent.interimInputTranscription.text;
        this.lastInterimAt = Date.now();
        this.onInterim(text);
      }

      // 4. Input transcription (texto consolidado y definitivo)
      if (serverContent.inputTranscription && serverContent.inputTranscription.text) {
        const text = serverContent.inputTranscription.text;
        this.lastFinalAt = Date.now();
        this.onFinal(text);
      }
    } catch (err) {
      console.error(`[GeminiLive:${this.sessionId}] Error parseando mensaje de Gemini:`, err);
    }
  }

  startWatchdog() {
    this.stopWatchdog();
    this.watchdogInterval = setInterval(() => {
      const now = Date.now();
      const audioActive = (now - this.lastAudioSentAt) < 1500; // Se envió audio en los últimos 1.5s
      const timeSinceLastMessage = now - this.lastGeminiMessageAt;

      // Si hay audio activo pero Gemini no responde en > 4 segundos, posible silent freeze
      if (audioActive && timeSinceLastMessage > 4000) {
        console.warn(`[GeminiLive:${this.sessionId}] Watchdog: Silencio de Gemini detectado (${timeSinceLastMessage}ms sin respuesta con audio activo). Reconectando...`);
        this.reconnect();
      }
    }, 1000);
  }

  stopWatchdog() {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
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
      console.log(`[GeminiLive:${this.sessionId}] Reconexión exitosa.`);
    } catch (err) {
      console.error(`[GeminiLive:${this.sessionId}] Error en reconexión:`, err);
    }
  }

  cleanup() {
    this.isConnected = false;
    this.stopWatchdog();
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
