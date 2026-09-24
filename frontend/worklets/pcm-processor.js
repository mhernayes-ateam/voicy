/**
 * StreamingPCMResampler AudioWorkletProcessor
 * 
 * Convierte el flujo de audio del micrófono (44.1kHz / 48kHz Float32)
 * a PCM 16-bit 16kHz mono Little-Endian mediante interpolación lineal continua (stateful).
 * 
 * Conserva el residuo fraccional y la última muestra entre bloques process()
 * para garantizar continuidad acústica y eliminar artefactos / chasquidos.
 * 
 * Agrupa chunks de 100 ms (1.600 muestras = 3.200 bytes) antes de despachar.
 */

class StreamingPCMResamplerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.targetSampleRate = 16000;
    this.chunkDurationMs = 100;
    // 16000 samples/seg * 0.1 seg = 1600 samples
    this.samplesPerChunk = Math.round((this.targetSampleRate * this.chunkDurationMs) / 1000);

    // Buffer acumulador de muestras Int16
    this.outputBuffer = new Int16Array(this.samplesPerChunk);
    this.outputBufferIndex = 0;

    // Estado persistente del resampler entre llamadas a process()
    this.fractionalIndex = 0.0;
    this.prevSample = 0.0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true;
    }

    const channelData = input[0]; // canal mono
    const inputLen = channelData.length;
    const inputSampleRate = sampleRate; // Global provisto por AudioWorkletGlobalScope

    // Ratio de muestreo (ej: 48000 / 16000 = 3.0, 44100 / 16000 = 2.75625)
    const ratio = inputSampleRate / this.targetSampleRate;

    let inIdx = this.fractionalIndex;

    while (inIdx < inputLen) {
      const idxFloor = Math.floor(inIdx);
      const frac = inIdx - idxFloor;

      const s0 = (idxFloor === 0) ? this.prevSample : channelData[idxFloor - 1];
      const s1 = channelData[idxFloor];

      // Interpolación lineal entre s0 y s1
      const interpolated = s0 + frac * (s1 - s0);

      // Clamping [-1.0, 1.0]
      const clamped = Math.max(-1.0, Math.min(1.0, interpolated));

      // Conversión Float32 a Signed Int16 Little-Endian
      const int16Val = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
      this.outputBuffer[this.outputBufferIndex++] = Math.round(int16Val);

      // Si completamos el chunk de 100ms (1.600 samples = 3.200 bytes)
      if (this.outputBufferIndex >= this.samplesPerChunk) {
        // Enviar buffer binario al hilo principal
        const chunkToSend = this.outputBuffer.slice().buffer;
        this.port.postMessage({
          type: 'pcm_chunk',
          buffer: chunkToSend,
          samples: this.samplesPerChunk,
          sampleRate: this.targetSampleRate
        }, [chunkToSend]);

        this.outputBufferIndex = 0;
      }

      inIdx += ratio;
    }

    // Conservar estado para el siguiente bloque process()
    this.fractionalIndex = inIdx - inputLen;
    this.prevSample = channelData[inputLen - 1];

    return true;
  }
}

registerProcessor('streaming-pcm-resampler', StreamingPCMResamplerProcessor);
