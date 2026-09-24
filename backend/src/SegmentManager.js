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
    this.finalizedPrefix = '';
    this.lastFinalSegment = null;
    this.silenceFinalizeTimer = null;
  }

  handleInterim(rawText) {
    if (!rawText) return;

    let currentText = rawText;
    if (this.finalizedPrefix && rawText.startsWith(this.finalizedPrefix)) {
      currentText = rawText.slice(this.finalizedPrefix.length).trim();
    } else if (this.finalizedPrefix && !rawText.startsWith(this.finalizedPrefix.slice(0, 15))) {
      // Si Gemini inició una nueva emisión independiente, reiniciar prefijo
      this.finalizedPrefix = '';
      currentText = rawText.trim();
    }

    if (!currentText) return;

    this.currentPartialText = currentText;
    const words = currentText.split(/\s+/).filter(Boolean);

    // Condición 1: Finalizar automáticamente si alcanza 11 palabras (máximo 2 líneas de subtítulo)
    // Condición 2: Finalizar si termina en puntuación (. ? !) y tiene al menos 4 palabras
    const hasPunctuation = /[.!?]$/.test(currentText) && words.length >= 4;
    const reachesWordLimit = words.length >= 11;

    if (hasPunctuation || reachesWordLimit) {
      if (this.silenceFinalizeTimer) {
        clearTimeout(this.silenceFinalizeTimer);
        this.silenceFinalizeTimer = null;
      }
      this.finalizedPrefix = rawText;
      this.handleFinal(currentText);
      return;
    }

    // Notificar interim
    this.notifyUpdate({
      type: 'interim',
      segmentId: this.currentSegmentId,
      sequence: this.sequence,
      partialText: currentText,
      updatedAt: Date.now()
    });

    // Auto-finalizar tras 1.2s de pausa en la voz si no hubo corte previo
    if (this.silenceFinalizeTimer) clearTimeout(this.silenceFinalizeTimer);
    this.silenceFinalizeTimer = setTimeout(() => {
      if (this.currentPartialText && this.currentPartialText.trim().length > 0) {
        this.finalizedPrefix = rawText;
        this.handleFinal(this.currentPartialText.trim());
      }
    }, 1200);
  }

  handleFinal(rawFinalText) {
    if (this.silenceFinalizeTimer) {
      clearTimeout(this.silenceFinalizeTimer);
      this.silenceFinalizeTimer = null;
    }

    if (!rawFinalText || !rawFinalText.trim()) return;

    let textToFinalize = rawFinalText.trim();
    if (this.finalizedPrefix && textToFinalize.startsWith(this.finalizedPrefix)) {
      textToFinalize = textToFinalize.slice(this.finalizedPrefix.length).trim();
    }
    // Reiniciar prefijo para la siguiente emisión
    this.finalizedPrefix = '';

    if (!textToFinalize) return;

    const endMs = Date.now();

    // Evitar procesar el mismo texto exacto dos veces seguidas en menos de 2s
    if (this.lastFinalSegment && this.lastFinalSegment.text === textToFinalize && (endMs - this.lastFinalSegment.endMs) < 2000) {
      return;
    }

    const finalSegment = {
      sessionId: this.sessionId,
      segmentId: this.currentSegmentId,
      sequence: this.sequence,
      startMs: this.segmentStartTime,
      endMs: endMs,
      text: textToFinalize,
      createdAt: new Date().toISOString()
    };

    this.lastFinalSegment = finalSegment;

    // Notificar segmento finalizado para traducción inmediata
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
