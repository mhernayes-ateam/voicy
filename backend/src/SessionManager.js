import { GeminiConnectionManager } from './GeminiConnectionManager.js';
import { SegmentManager } from './SegmentManager.js';
import { FirebasePublisher } from './FirebasePublisher.js';
import { Translator } from './Translator.js';

/**
 * SessionManager
 * 
 * Gestiona el conjunto de sesiones activas de conferencias.
 * Asocia cada broadcaster a su respectiva conexión de Gemini Live, su SegmentManager y su pipeline de traducción.
 */
export class SessionManager {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY;
    this.publisher = new FirebasePublisher();
    this.translator = new Translator(this.apiKey);
    this.sessions = new Map(); // sessionId -> SessionContext
  }

  async getOrCreateSession(sessionId, broadcasterWs) {
    let session = this.sessions.get(sessionId);

    if (!session) {
      console.log(`[SessionManager] Creando nueva sesión: ${sessionId}`);

      const segmentManager = new SegmentManager(sessionId, async (payload) => {
        // Enviar actualizaciones a Firebase RTDB
        if (payload.type === 'interim') {
          this.publisher.publishPartial(sessionId, payload);
        } else if (payload.type === 'final') {
          this.publisher.publishFinal(sessionId, payload);

          // Disparar traducción al idioma contrario en paralelo
          this.translateAndPublish(sessionId, payload.segment);
        }

        // Si el broadcaster está conectado, enviarle un evento de feedback
        if (session && session.broadcasterWs && session.broadcasterWs.readyState === 1) {
          session.broadcasterWs.send(JSON.stringify({
            type: payload.type,
            data: payload
          }));
        }
      });

      const geminiClient = new GeminiConnectionManager({
        apiKey: this.apiKey,
        sessionId: sessionId,
        onInterim: (text) => segmentManager.handleInterim(text),
        onFinal: (text) => segmentManager.handleFinal(text),
        onError: (err) => {
          if (session && session.broadcasterWs && session.broadcasterWs.readyState === 1) {
            session.broadcasterWs.send(JSON.stringify({
              type: 'gemini_error',
              error: err.message
            }));
          }
        },
        onStatusChange: (status) => {
          if (session && session.broadcasterWs && session.broadcasterWs.readyState === 1) {
            session.broadcasterWs.send(JSON.stringify({
              type: 'gemini_status',
              status: status
            }));
          }
        }
      });

      session = {
        sessionId,
        broadcasterWs,
        geminiClient,
        segmentManager,
        createdAt: Date.now()
      };

      this.sessions.set(sessionId, session);

      // Conectar a Gemini Live API
      try {
        await geminiClient.connect();
      } catch (err) {
        console.error(`[SessionManager] No se pudo conectar a Gemini para la sesión ${sessionId}:`, err.message);
      }
    } else {
      console.log(`[SessionManager] Reconectando broadcaster a sesión existente: ${sessionId}`);
      session.broadcasterWs = broadcasterWs;

      // Si geminiClient está desconectado, reconectarlo
      if (!session.geminiClient || !session.geminiClient.isConnected) {
        console.log(`[SessionManager] Gemini desconectado en sesión existente ${sessionId}. Reconectando...`);
        try {
          await session.geminiClient.connect();
        } catch (err) {
          console.error(`[SessionManager] Error reconectando Gemini:`, err.message);
        }
      }

      // Notificar inmediatamente al broadcaster del estado de Gemini
      const status = session.geminiClient && session.geminiClient.isConnected ? 'connected' : 'disconnected';
      if (broadcasterWs && broadcasterWs.readyState === 1) {
        broadcasterWs.send(JSON.stringify({
          type: 'gemini_status',
          status: status
        }));
      }
    }

    return session;
  }

  handleBroadcasterAudio(sessionId, pcmBuffer) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.geminiClient) {
      return false;
    }
    return session.geminiClient.sendAudioChunk(pcmBuffer);
  }

  handleBroadcasterDisconnect(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      console.log(`[SessionManager] Broadcaster desconectado de ${sessionId}`);
      session.broadcasterWs = null;
    }
  }

  async translateAndPublish(sessionId, segment) {
    try {
      const tStart = Date.now();
      const result = await this.translator.translateAuto(segment.text);
      const tEnd = Date.now();

      const translationLatencyMs = tEnd - tStart;
      const totalTranslatedLatencyMs = tEnd - (segment.startMs || tStart);

      const payload = {
        segmentId: segment.segmentId,
        sequence: segment.sequence,
        sourceLang: result.sourceLang,
        targetLang: result.targetLang,
        text: result.text,
        translationLatencyMs: translationLatencyMs,
        totalTranslatedLatencyMs: totalTranslatedLatencyMs,
        updatedAt: tEnd
      };

      // Publicar en RTDB /translations/{targetLang} y /activeTranslation
      await this.publisher.publishTranslation(sessionId, payload);

      // Si el broadcaster está conectado, enviarle también el evento de traducción con métricas
      const session = this.sessions.get(sessionId);
      if (session && session.broadcasterWs && session.broadcasterWs.readyState === 1) {
        session.broadcasterWs.send(JSON.stringify({
          type: 'translation',
          data: payload
        }));
      }
    } catch (err) {
      console.error(`[SessionManager] Error traduciendo segmento para ${sessionId}:`, err);
    }
  }

  terminateSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.geminiClient) {
        session.geminiClient.cleanup();
      }
      this.sessions.delete(sessionId);
      console.log(`[SessionManager] Sesión ${sessionId} terminada.`);
    }
  }
}
