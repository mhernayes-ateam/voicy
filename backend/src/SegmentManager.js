/**
 * SegmentManager
 * 
 * Gestiona el ciclo de vida de los segmentos de audio/texto.
 * Emplea la fuente de verdad de Gemini con auto-finalización inteligente por silencio:
 * - interimInputTranscription -> actualiza el estado parcial actual e inicia timer de silencio.
 * - inputTranscription        -> consolida el segmento final e incrementa la secuencia.
 * - silenceFinalizeTimer      -> consolida el texto tras 1.8s de silencio si Gemini aún no envió final.
 */

function generateSegmentId(prefix = 'seg') {
  const timestamp = Date.now().toString(36);
  const randomStr = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}_${randomStr}`;
}

export class SegmentManager {
  constructor(sessionId, onSegmentUpdate = () => {}) {
    this.sessionId = sessionId;
    this.onSegmentUpdate = onSegmentUpdate;

    this.sequence = 0;
    this.currentSegmentId = generateSegmentId();
    this.segmentStartTime = Date.now();

    this.currentPartialText = '';
    this.lastFinalSegment = null;
    this.silenceFinalizeTimer = null;
  }

  handleInterim(text) {
    if (!text) return;
    this.currentPartialText = text;

    // Notificar interim inmediatamente con latencia cero
    this.notifyUpdate({
      type: 'interim',
      segmentId: this.currentSegmentId,
      sequence: this.sequence,
      partialText: text,
      updatedAt: Date.now()
    });

    // Auto-finalizar tras 1.5s de pausa natural en la voz si Gemini no envió final aún
    if (this.silenceFinalizeTimer) clearTimeout(this.silenceFinalizeTimer);
    this.silenceFinalizeTimer = setTimeout(() => {
      if (this.currentPartialText && this.currentPartialText.trim().length > 0) {
        this.handleFinal(this.currentPartialText.trim());
      }
    }, 1500);
  }

  handleFinal(finalText) {
    if (this.silenceFinalizeTimer) {
      clearTimeout(this.silenceFinalizeTimer);
      this.silenceFinalizeTimer = null;
    }

    if (!finalText || !finalText.trim()) return;

    const trimmed = finalText.trim();
    const endMs = Date.now();

    // Evitar procesar el mismo texto exacto dos veces seguidas en menos de 1.5s
    if (this.lastFinalSegment && this.lastFinalSegment.text === trimmed && (endMs - this.lastFinalSegment.endMs) < 1500) {
      return;
    }

    const finalSegment = {
      sessionId: this.sessionId,
      segmentId: this.currentSegmentId,
      sequence: this.sequence,
      startMs: this.segmentStartTime,
      endMs: endMs,
      text: trimmed,
      createdAt: new Date().toISOString()
    };

    this.lastFinalSegment = finalSegment;

    // Notificar segmento finalizado para traducción
    this.notifyUpdate({
      type: 'final',
      segment: finalSegment,
      updatedAt: endMs
    });

    // Avanzar secuencia para el siguiente segmento
    this.sequence++;
    this.currentSegmentId = generateSegmentId();
    this.segmentStartTime = endMs;
    this.currentPartialText = '';
  }

  notifyUpdate(payload) {
    if (typeof this.onSegmentUpdate === 'function') {
      this.onSegmentUpdate(payload);
    }
  }

  getCurrentState() {
    return {
      sessionId: this.sessionId,
      current: {
        segmentId: this.currentSegmentId,
        sequence: this.sequence,
        partialText: this.currentPartialText,
        updatedAt: Date.now()
      },
      lastFinal: this.lastFinalSegment
    };
  }
}
