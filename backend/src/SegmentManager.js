/**
 * SegmentManager
 * 
 * Gestiona el ciclo de vida de los segmentos de audio/texto.
 * Emplea la fuente de verdad de Gemini:
 * - interimInputTranscription -> actualiza el estado parcial actual.
 * - inputTranscription        -> consolida el segmento final e incrementa la secuencia.
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
  }

  handleInterim(text) {
    this.currentPartialText = text;
    this.notifyUpdate({
      type: 'interim',
      segmentId: this.currentSegmentId,
      sequence: this.sequence,
      partialText: text,
      updatedAt: Date.now()
    });
  }

  handleFinal(finalText) {
    const endMs = Date.now();
    const finalSegment = {
      sessionId: this.sessionId,
      segmentId: this.currentSegmentId,
      sequence: this.sequence,
      startMs: this.segmentStartTime,
      endMs: endMs,
      text: finalText,
      createdAt: new Date().toISOString()
    };

    this.lastFinalSegment = finalSegment;

    // Notificar segmento finalizado
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
