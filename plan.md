# Voicy — Live Captions Platform (Vibeathon 2026)
## Arquitectura & Plan de Ejecución (Iteración 1: Pipeline-First)

---

## 1. Visión y Decisiones de Infraestructura

- **Aislamiento total:** Proyecto nuevo independiente en Google Cloud / Firebase: `voicy-live`.
  - Cero riesgo de afectar recursos productivos de `the-ateam-ai`.
  - Métricas, cuotas, facturación, IAM y Secret Manager independientes.
  - Base limpia para abrir el código como Open Source.
- **Dominio:** `live.the-ateam.ai` configurado en Firebase Hosting del proyecto `voicy-live`.
- **Estrategia de Datos Híbrida:**
  - **Firebase Realtime Database (RTDB):** Para subtítulos vivos e incrementales (baja latencia, hasta 200.000 conexiones concurrentes por instancia).
  - **Cloud Firestore:** Para persistencia durable (sesiones, metadatos, glosarios y segmentos definitivos para exportación VTT/SRT).

---

## 2. Diagrama de Arquitectura del Pipeline

```text
MICRÓFONO (Browser Broadcaster)
    │  (44.1 kHz / 48 kHz Float32)
    ▼
[AudioWorklet: StreamingPCMResampler]
    │  (Stateful interpolation -> 16 kHz Int16 Mono Little-Endian)
    │  (Agrupado en chunks de 100 ms = 1.600 samples = 3.200 bytes)
    ▼
[WebSocket binario (/ws/broadcast/:sessionId)]
    ▼
┌────────────────────────────────────────────────────────┐
│ Cloud Run / Local Backend (caption-stream)             │
│                                                        │
│  ConferenceSession (45-60 min)                         │
│  ├── Broadcaster WebSocket                             │
│  ├── SegmentManager (sequence & segmentId GLOBAL)      │
│  └── GeminiConnectionManager                           │
│       ├── TranscriptionSession #1 (0 ➔ ~9 min)         │
│       │    └─► Rotación limpia al finalizar segmento   │
│       ├── TranscriptionSession #2 (~9 ➔ ~18 min)       │
│       └── Session Resumption / GoAway / Watchdog       │
└───────────────────────────┬────────────────────────────┘
                            │ WebSocket
                            ▼
┌────────────────────────────────────────────────────────┐
│ Gemini 3.5 Transcribe Live                             │
│ Modelo: gemini-3.5-transcribe-live                     │
│ config:                                                │
│   inputAudioTranscription: {                           │
│     languageCodes: [],                                 │
│     mode: "SMART",                                     │
│     customVocabulary: ["Nerdearla", "Gemini", ...]     │
│   }                                                    │
└─────────────┬────────────────────────────┬─────────────┘
              │ interimInputTranscription  │ inputTranscription
              ▼                            ▼
      [PARTIAL HYPOTHESIS]          [FINAL SEGMENT]
              │                            │
              ▼                            ├──────────────────────────┐
    Firebase Realtime DB                   ▼                          ▼
    /liveSessions/:id/current        Iteración 2:              Iteración 2:
              │                      Traducción                Firestore
              ▼                      Gemini Flash-Lite         /sessions/:id/segments
       AUDIENCIA (Mobile)                  │
       /session/:sessionId                 ▼
       (render throttle 80-120ms)   Firebase RTDB (/translations/es)
```

---

## 3. Especificaciones Técnicas Críticas

### 3.1. AudioWorklet & Resampler Stateful (`StreamingPCMResampler`)
- **Problema resuelto:** Los bloques recibidos en `process()` no deben reiniciar el índice de interpolación ni descartar fracciones de muestra entre llamadas (evita distorsiones y pops).
- **Componente:** `StreamingPCMResampler` mantiene entre frames:
  - `fractionalIndex` (posición continua entre muestras de entrada).
  - `prevSample` (última muestra del frame previo para interpolación lineal suave).
- **Batching:** Agrupa exactamente 100 ms (1.600 muestras = 3.200 bytes en Int16 mono little endian) antes de despachar vía `postMessage` al WebSocket.

### 3.2. Setup de Gemini Live & Vocabulario Técnico Nativo
- **Modelo:** `gemini-3.5-transcribe-live`.
- **Configuración de sesión:**
  ```javascript
  const config = {
    responseModalities: ["TEXT"],
    inputAudioTranscription: {
      languageCodes: [], // Detección automática continua de idioma
      mode: "SMART",     // Limpia muletillas y falsos arranques para subtítulos legibles
      customVocabulary: [
        "Nerdearla", "Gemini", "Kubernetes", "TypeScript", "React",
        "A-TEAM", "Cloud Run", "Firestore", "Antigravity", "Voicy"
      ] // Hasta 100-1000 términos nativos de la conferencia
    }
  };
  ```

### 3.3. Detección Nativa de Partial vs Final (Fuente de Verdad de Gemini)
Gemini Live expone explícitamente los dos tipos de eventos sin necesidad de heurísticas:
- **`serverContent.interimInputTranscription` (Partial)**: Hipótesis provisional en evolución. Se actualiza en tiempo real en memoria y se publica a RTDB (`current.partialText`).
- **`serverContent.inputTranscription` (Final)**: Transcripción consolidada y autoritativa producida por el modelo. Fija el `finalText` del segmento, incrementa el `sequence` e inicia la fase de traducción/persistencia.

```javascript
if (serverContent.interimInputTranscription) {
  segmentManager.updatePartial(sessionId, serverContent.interimInputTranscription.text);
}
if (serverContent.inputTranscription) {
  segmentManager.finalizeSegment(sessionId, serverContent.inputTranscription.text);
}
```

### 3.4. Ciclo de Vida: ConferenceSession vs TranscriptionSessions (~9 min)
- **El límite de 10 minutos de Gemini Transcribe Live**:
  - `gemini-3.5-transcribe-live` admite streaming continuo por hasta 10 minutos por sesión.
  - La arquitectura **desacopla** la sesión de la conferencia de la conexión con el modelo:
    ```text
    ConferenceSession (45 min)
      ├── TranscriptionSession #1 (0 ➔ ~9 min)
      ├── TranscriptionSession #2 (~9 ➔ ~18 min)
      └── TranscriptionSession #3 (~18 ➔ ~27 min)
    ```
  - **Continuidad Absoluta:** `SegmentManager` es el dueño de la secuencia (`sequence`). Cuando una sesión de Gemini se renueva a los 9 minutos, la secuencia no se reinicia; el segmento $N$ finaliza en la sesión anterior y el segmento $N+1$ arranca en la nueva sesión. La audiencia jamás percibe la transición.
  - **Session Resumption & GoAway:** Se mantiene la captura del `sessionHandle` para reconexiones por caída de red o avisos `GoAway`.
- **Watchdog Anti-Freeze**:
  - Registra: `lastAudioSentAt`, `lastGeminiMessageAt`, `lastInterimAt`, `lastFinalAt`.
  - Si se detecta nivel de audio activo (RMS / speech) pero transcurren > 4 segundos sin recibir mensajes de Gemini, se clasifica el estado como degradado y se gatilla una rotación/reconexión inmediata.

### 3.5. Métricas Clave de Latencia Desacopladas
No se utiliza un número único genérico de latencia. Se miden de forma independiente:
- **`partialLatencyMs` (Target: < 1.5s):** Tiempo desde que el orador pronuncia la palabra hasta que el `interimInputTranscription` se renderiza en pantalla. Define la agilidad percibida.
- **`finalLatencyMs` (Target: < 3.0s):** Tiempo hasta que la frase se consolida de forma definitiva en `inputTranscription`.

### 3.6. Estructura de Realtime Database
```json
{
  "liveSessions": {
    "test": {
      "status": "live",
      "current": {
        "segmentId": "seg_01...",
        "sequence": 1,
        "partialText": "Welcome to Nerdearla. Today we're going to...",
        "updatedAt": 1727210000000
      },
      "lastFinal": {
        "segmentId": "seg_00...",
        "sequence": 0,
        "text": "Hello everyone."
      },
      "metrics": {
        "partialLatencyMs": 620,
        "finalLatencyMs": 2100,
        "health": "healthy"
      }
    }
  }
}
```

---

## 4. Fases de Ejecución

### Fase 1: Entorno, Git & Proyecto Firebase (COMPLETADA)
- [x] Inicializar Git en `/Users/martinhernayes/Desktop/Web Catalog/voicy`.
- [x] Configuración de Firebase (`firebase.json`, `.firebaserc` para `voicy-live`).
- [x] Estructura base de carpetas `frontend/` y `backend/`.

### Fase 2: Ingesta de Audio (Frontend Broadcaster) (COMPLETADA)
- [x] `StreamingPCMResampler` en `frontend/worklets/pcm-processor.js`.
- [x] Batching de 100 ms (1.600 muestras / 3.200 bytes en Int16 mono little endian).
- [x] Panel de speaker `/broadcast/test` con vúmetro y controles START/STOP.

### Fase 3: Backend de Transmisión & Gemini Live (COMPLETADA)
- [x] Servidor HTTP + WebSocket en `/ws/broadcast/:sessionId`.
- [x] `GeminiConnectionManager` con soporte de rotación de `TranscriptionSession` a los 9 min, GoAway, resumption y watchdog.
- [x] `SegmentManager` con `sequence` global monótono que persiste entre rotaciones de Gemini.

### Fase 4: Sincronización en Tiempo Real & Audiencia (COMPLETADA)
- [x] Firebase Admin SDK publicando en RTDB (`/liveSessions/:sessionId`).
- [x] UI de audiencia `/session/test` con render throttling de 100 ms.

### Fase 5: Validación End-to-End (Prueba en Vivo)
- [ ] Configurar `GEMINI_API_KEY` en `backend/.env`.
- [ ] Ejecutar prueba local de transmisión de voz (speaker ➔ audiencia).
- [ ] Verificar `partialLatencyMs < 1.5s` y `finalLatencyMs < 3.0s`.

---

## 5. Iteraciones Posteriores (Roadmap)

- **Iteración 2 (Traducción & Persistencia):**
  - Pipeline de traducción al español con `gemini-3.5-flash-lite` sobre cada `inputTranscription` definitivo.
  - Publicación de traducciones en RTDB (`/liveSessions/:id/translations/es`).
  - Persistencia de segmentos definitivos en Firestore (`sessions/{id}/segments`).
  - Gestión dinámica de `customVocabulary` por sala.
- **Iteración 3 (Multi-Stage & Production Ready):**
  - Selector de salas en `/` (Main Stage, AI Room, DevOps, etc.).
  - Panel `/admin` para administración de conferencias y glosarios.
  - Exportación de conferencias a formato `.srt` y `.vtt`.
  - Despliegue en Google Cloud Run (`caption-stream`) y Firebase Hosting (`live.the-ateam.ai`).
