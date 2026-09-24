# Voicy — Live Captions Platform (Nerdearla Vibeathon 2026)
## Arquitectura & Plan Maestro de Entrega

---

## 1. Visión y Decisiones de Infraestructura

- **Aislamiento Total:** Proyecto nuevo independiente en Google Cloud / Firebase: `voicy-live`.
  - Cero riesgo de afectar recursos productivos de `the-ateam-ai`.
  - Métricas, cuotas, facturación, IAM y Secret Manager independientes.
  - Base limpia y lista para abrir el código como Open Source con licencia MIT.
- **Dominio:** `live.the-ateam.ai` configurado en Firebase Hosting del proyecto `voicy-live`.
- **Estrategia Híbrida de Datos:**
  - **Firebase Realtime Database (RTDB):** Para subtítulos vivos e incrementales (baja latencia sub-100ms, hasta 200.000 conexiones concurrentes por instancia).
  - **Cloud Firestore:** Para persistencia durable (sesiones, metadatos, glosarios y exportación VTT/SRT).

---

## 2. Alineación Estricta con los Requisitos de Nerdearla (Gatekeepers)

Para ser evaluado por el jurado, el proyecto cubre al 100% los requisitos obligatorios:

1. **Audio en vivo multi-fuente:** Micrófono del orador + opción de **Audio de Prueba simulado** (muestra de audio de Nerdearla) para evaluación directa con 1 clic.
2. **Transcripción en tiempo real:** Original con `gemini-3.5-transcribe-live` (Modo SMART y auto-detección multi-idioma).
3. **Traducción simultánea bidireccional:** Pipeline con `gemini-2.5-flash` / `gemini-3.5-flash-lite` traduciendo de **Inglés ➔ Español** y de **Español ➔ Inglés** en tiempo real.
4. **Vista de Audiencia:** Web `/session/:slug` mobile-first con selector interactivo `[ ORIGINAL ]` y `[ TRADUCCIÓN ]`.
5. **Multi-Sesión Simultánea (Escalabilidad):** Mínimo 2 escenarios independientes en paralelo (`main-stage` y `ai-stage`), con arquitectura desacoplada para escalar a 30+ escenarios.
6. **Open Source:** Repositorio público bajo Licencia MIT y `README.md` exhaustivo con guía de despliegue y arquitectura de escala.

---

## 3. Diagrama de Arquitectura Multisesión (Nerdearla Scale)

```text
ESCENARIO 1 (main-stage)                      ESCENARIO 2 (ai-stage)              ... ESCENARIOS 3 A 30
Speaker Mic / Audio Sample                    Speaker Mic / Audio Sample              Speaker Mic
        │ (16kHz PCM Int16 100ms)                     │ (16kHz PCM Int16 100ms)               │
        ▼                                             ▼                                       ▼
┌───────────────────────────────┐             ┌───────────────────────────────┐       ┌───────────────────────────────┐
│ Cloud Run: caption-stream #1  │             │ Cloud Run: caption-stream #2  │       │ Cloud Run: caption-stream #N  │
│                               │             │                               │       │                               │
│ ConferenceSession: main-stage │             │ ConferenceSession: ai-stage   │       │ ConferenceSession: stage-N    │
│ ├── Broadcaster WebSocket     │             │ ├── Broadcaster WebSocket     │       │ ├── Broadcaster WebSocket     │
│ ├── SegmentManager (sequence) │             │ ├── SegmentManager (sequence) │       │ ├── SegmentManager (sequence) │
│ ├── Gemini 3.5 Transcribe Live│             │ ├── Gemini 3.5 Transcribe Live│       │ ├── Gemini 3.5 Transcribe Live│
│ │    └─► interim (partial)    │             │ │    └─► interim (partial)    │       │ │    └─► interim (partial)    │
│ │    └─► inputTranscription   │             │ │    └─► inputTranscription   │       │ │    └─► inputTranscription   │
│ └── Gemini Flash (Translate)  │             │ └── Gemini Flash (Translate)  │       │ └── Gemini Flash (Translate)  │
│      └─► EN ➔ ES / ES ➔ EN    │             │      └─► EN ➔ ES / ES ➔ EN    │       │      └─► EN ➔ ES / ES ➔ EN    │
└──────────────┬────────────────┘             └──────────────┬────────────────┘       └──────────────┬────────────────┘
               │                                             │                                       │
               ▼                                             ▼                                       ▼
    Firebase Realtime Database                    Firebase Realtime Database              Firebase Realtime Database
    /liveSessions/main-stage                      /liveSessions/ai-stage                  /liveSessions/stage-N
               │                                             │                                       │
      ┌────────┴────────┐                           ┌────────┴────────┐                              │
      ▼                 ▼                           ▼                 ▼                              ▼
  AUDIENCIA 1      AUDIENCIA 1.500              AUDIENCIA 1       AUDIENCIA 800                  AUDIENCIA CELULARES
  (Mobile Web)     (Mobile Web)                 (Mobile Web)      (Mobile Web)                   (Mobile Web)
```

### Principio de Escala: 1 Stream por Escenario
- **Gemini nunca procesa espectadores individuales:** 1 escenario = 1 stream de audio hacia Gemini = costo y cuota predecible.
- **Distribución vía RTDB:** 1 nodo por sala actualiza deltas en memoria y distribuye a miles de teléfonos concurrentes (<100ms).

---

## 4. Especificaciones Técnicas Detalladas

### 4.1. AudioWorklet & Resampler Stateful (`StreamingPCMResampler`)
- Resampling continuo de la tasa nativa del dispositivo (44.1kHz o 48kHz) a 16kHz Int16 Mono Little-Endian.
- Conserva el residuo fraccional (`fractionalIndex`) y la muestra previa (`prevSample`) entre llamadas a `process()` para evitar discontinuidades acústicas o chasquidos.
- Empaqueta exactamente chunks de 100 ms (1.600 muestras = 3.200 bytes) antes de despachar vía WebSocket.

### 4.2. Setup de Gemini Live & Glosario Técnico Nativo
- **Modelo:** `gemini-3.5-transcribe-live`.
- **Configuración:**
  ```javascript
  const config = {
    responseModalities: ["TEXT"],
    inputAudioTranscription: {
      languageCodes: [], // Auto-detección continua de idioma
      mode: "SMART",     // Limpia muletillas, repeticiones y falsos arranques
      customVocabulary: [
        "Nerdearla", "Gemini", "Kubernetes", "TypeScript", "React",
        "A-TEAM", "Cloud Run", "Firestore", "Antigravity", "Voicy", "Docker"
      ] // Glosario técnico de hasta 100-1000 términos
    }
  };
  ```

### 4.3. Fuente de Verdad para Partial y Final
Gemini Live define nativamente los dos eventos sin requerir heurísticas arbitrarias:
- **`interimInputTranscription` (Partial):** Hipótesis viva de baja latencia. Se emite inmediatamente a RTDB en `current.partialText`.
- **`inputTranscription` (Final):** Segmento autoritativo de fin de turno. Fija `lastFinal.text`, avanza la secuencia global monótona (`sequence++`) y dispara la traducción paralela.

### 4.4. Ciclo de Vida: ConferenceSession vs TranscriptionSessions (~9 min)
- **Límite de 10 minutos:** `gemini-3.5-transcribe-live` tiene un límite de 10 minutos por conexión continua.
- **Desacoplamiento:**
  - `ConferenceSession` dura toda la charla (45-60 min).
  - `SegmentManager` es el único dueño de `sequence` y `segmentId`. La secuencia NUNCA se reinicia.
  - `GeminiConnectionManager` rota la conexión a los ~9 minutos de forma transparente entre segmentos. La audiencia nunca nota la transición.
  - Manejo de `sessionResumption` ante cortes de red y soporte de mensajes `GoAway`.
- **Watchdog Anti-Freeze:**
  - Si hay audio activo pero no se recibe respuesta de Gemini en > 4 segundos, se clasifica como estado degradado y se gatilla una reconexión/rotación proactiva.

### 4.5. Traducción Simultánea Bidireccional (`gemini-3.5-flash-lite`)
- **Modelo:** `gemini-3.5-flash-lite` (diseñado específicamente para alto throughput, bajo costo y baja latencia).
- **Detección y traducción automática:**
  - Si el orador habla en inglés ➔ Traduce al español latinoamericano.
  - Si el orador habla en español ➔ Traduce al inglés.
- Preserva estrictamente nombres de librerías, marcas y términos técnicos verbatim.
- **Target translation latency:** < 750 ms (medición empírica en tiempo real).

### 4.6. Desglose de Métricas de Latencia de Ingeniería
En el estudio de transmisión se monitorizan 4 métricas desacopladas:
- **`partialLatencyMs` (Target: < 1.5s):** Tiempo desde la voz hasta la hipótesis visual en pantalla. Define la agilidad percibida.
- **`finalLatencyMs` (Target: < 3.0s):** Tiempo hasta la consolidación autoritativa de la frase completa por parte de Gemini Live.
- **`translationLatencyMs` (Target: < 750ms):** Tiempo de respuesta del modelo Flash-Lite al traducir la frase consolidada.
- **`totalTranslatedLatencyMs` (Target: < 3.5s):** Tiempo total de ciclo completo desde la voz original hasta la entrega del subtítulo traducido.

---

## 5. Estructura de Realtime Database
```json
{
  "liveSessions": {
    "main-stage": {
      "status": "live",
      "current": {
        "segmentId": "seg_01...",
        "sequence": 42,
        "partialText": "Welcome to Nerdearla. Today we're...",
        "updatedAt": 1727210000000
      },
      "lastFinal": {
        "segmentId": "seg_00...",
        "sequence": 41,
        "text": "Hello everyone.",
        "updatedAt": 1727209990000
      },
      "activeTranslation": {
        "sourceLang": "en",
        "targetLang": "es",
        "text": "Hola a todos.",
        "sequence": 41,
        "updatedAt": 1727209991000
      },
      "metrics": {
        "partialLatencyMs": 580,
        "finalLatencyMs": 1950,
        "health": "healthy"
      }
    }
  }
}
```

---

## 6. Estado de Implementación & Roadmap

### Fase 1: Scaffolding, Git & Firebase (COMPLETADA)
- [x] Repositorio Git inicializado y estructurado (`voicy`).
- [x] Configuración Firebase Hosting, RTDB y Firestore rules para `voicy-live`.
- [x] Licencia MIT y `README.md` con guía de escalabilidad.

### Fase 2: Ingesta de Audio & Broadcaster Studio (COMPLETADA)
- [x] `StreamingPCMResampler` AudioWorklet (16kHz Int16 Mono, chunks de 100ms).
- [x] Panel de control del broadcaster (`/broadcast/:id`) con vúmetro y métricas separadas (`partialLatencyMs` y `finalLatencyMs`).
- [x] Selector dual de entrada: Micrófono en vivo o Audio de Prueba para evaluación con 1 clic.

### Fase 3: Backend Caption-Stream & Gemini Live (COMPLETADA)
- [x] Servidor WebSocket y HTTP health checks en Node.js (`server.js`).
- [x] `GeminiConnectionManager` con soporte de `gemini-3.5-transcribe-live`, `customVocabulary`, rotación preventiva a los 9 min, GoAway y Watchdog.
- [x] `SegmentManager` con secuencia monótona desacoplada de las sesiones efímeras de Gemini.

### Fase 4: Traducción Bidireccional & Audiencia (COMPLETADA)
- [x] `Translator.js` con Gemini Flash (detección automática y traducción EN ➔ ES / ES ➔ EN).
- [x] Publicador en Firebase RTDB (`/liveSessions/:id/activeTranslation`).
- [x] Interfaz de audiencia mobile-first (`/session/:id`) con selector `[ ORIGINAL ]` / `[ TRADUCCIÓN ]` y render suavizado (throttling 80ms).
- [x] Selector multisesión en `/` para demostrar 2 salas simultáneas (`main-stage` y `ai-stage`).

### Fase 5: Validación End-to-End & Demo (EN CURSO)
- [ ] Configurar `GEMINI_API_KEY` en `backend/.env`.
- [ ] Validación local de transmisión simultánea de 2 salas con audio en inglés y español.
- [ ] Grabar video demo de 1 a 2 minutos para Devpost.
- [ ] Publicar repositorio en GitHub (`mhernayes-ateam/voicy`).
