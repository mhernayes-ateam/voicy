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
│  ├── SessionManager (estado de conferencia)            │
│  ├── GeminiConnectionManager                           │
│  │    ├── Ciclo de vida y límites (reconnect < 10 min)  │
│  │    ├── Session Resumption & GoAway handling         │
│  │    └── Watchdog de silencio / detección freeze      │
│  └── SegmentManager (segmentId, seq, timestamps)       │
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

### 3.4. Resiliencia, Límite de 10 Minutos y Watchdog (`GeminiConnectionManager`)
- **Límite de 10 minutos de Gemini Live Transcribe**:
  - `gemini-3.5-transcribe-live` tiene un límite operativo de 10 minutos por sesión WebSocket continua.
  - El `GeminiConnectionManager` almacena el `geminiSessionHandle` para **Session Resumption**.
  - Reconexión programada transparente (o reacción inmediata a mensajes `GoAway`) antes de alcanzar el minuto 9:30, preservando el contexto y la continuidad de la conferencia.
- **Watchdog Anti-Freeze**:
  - Registra: `lastAudioSentAt`, `lastGeminiMessageAt`, `lastInterimAt`, `lastFinalAt`.
  - Si se detecta nivel de audio activo (RMS / speech) pero transcurren > 4 segundos sin recibir mensajes de Gemini, se clasifica el estado como degradado y se gatilla una reconexión controlada vía sesión handle.

### 3.5. Estructura de Realtime Database
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
        "latencyMs": 750,
        "health": "healthy"
      }
    }
  }
}
```

---

## 4. Fases de Ejecución

### Fase 1: Entorno, Git & Proyecto Firebase
- [ ] Inicializar Git en `/Users/martinhernayes/Desktop/Web Catalog/voicy`.
- [ ] Vincular remoto en GitHub (`mhernayes-ateam/voicy`).
- [ ] Inicializar configuración de Firebase (`firebase.json`, `.firebaserc` para `voicy-live`).
- [ ] Estructura base de carpetas:
  - `frontend/` (HTML, CSS, JS de clientes, AudioWorklet).
  - `backend/` (Node.js WebSocket server, Gemini Live client, managers).

### Fase 2: Ingesta de Audio (Frontend Broadcaster)
- [ ] Implementar `StreamingPCMResampler` en `frontend/worklets/pcm-processor.js` (interpolación fraccional continua).
- [ ] Captura de micrófono con `AudioWorkletNode` y batching de 100 ms (1.600 muestras / 3.200 bytes).
- [ ] Envío por WebSocket binario (`ArrayBuffer`).
- [ ] UI `/broadcast/test`:
  - Botones START / STOP.
  - Indicadores: Micrófono (OK), WebSocket (Conectado), Gemini (Conectado/Degradado).
  - Medidor de nivel de audio (Vúmetro).
  - Monitor en vivo de transcript y latencia.

### Fase 3: Backend de Transmisión & Gemini Live
- [ ] Servidor HTTP + WebSocket en `/ws/broadcast/:sessionId`.
- [ ] `GeminiConnectionManager`:
  - Conexión WebSocket a `gemini-3.5-transcribe-live`.
  - Configuración con `mode: "SMART"` y `customVocabulary`.
  - Soporte de Session Resumption & GoAway.
  - Watchdog de actividad.
- [ ] `SegmentManager`:
  - Escucha de `interimInputTranscription` (partial) e `inputTranscription` (final).
  - Asignación de `segmentId` y `sequence`.

### Fase 4: Sincronización en Tiempo Real & Audiencia
- [ ] Firebase Admin SDK publicando en RTDB (`/liveSessions/:sessionId`).
- [ ] UI de audiencia `/session/test`:
  - Mobile-first, diseño oscuro, badge `LIVE ●`.
  - Listener sobre `/liveSessions/test/current`.
  - Throttling visual de 80–120 ms para transiciones suaves de texto.

### Fase 5: Validación End-to-End (Hito de Iteración 1)
- [ ] Ventana A: `/broadcast/test` con micrófono activo hablando en inglés.
- [ ] Ventana B: `/session/test` en otro dispositivo/pestaña.
- [ ] Criterio de éxito: Transcripción fluida en tiempo real con latencia **< 2 segundos**.

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
