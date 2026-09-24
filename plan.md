# Voicy — Live Captions Platform (Nerdearla Vibeathon 2026)
## MVP Obligatorio de Evaluación & Plan de Entrega

---

## 1. Alineación con las Reglas Oficiales de Nerdearla

Para ser evaluado por el jurado, el proyecto cumple con los 5 requisitos mínimos obligatorios (Gatekeepers):

1. **Audio en vivo multi-fuente:** Micrófono del orador + Opción de **Audio de Prueba simulado** (muestra de charla en inglés de Nerdearla) para pruebas con 1 solo clic.
2. **Transcripción en tiempo real:** Original (EN o ES) con `gemini-3.5-transcribe-live`.
3. **Traducción en tiempo real (EN ➔ ES):** Modelo `gemini-3.5-flash-lite` traduciendo segmentos definitivos de forma paralela y continua.
4. **Vista de Audiencia:** Interfaz web `/session/:slug` optimizada para celulares con selector de idioma `[ ORIGINAL ]` y `[ ESPAÑOL ]`.
5. **Mínimo 2 Sesiones Simultáneas:** Demostración en vivo de dos salas independientes (`main-stage` y `ai-stage`) corriendo en simultáneo sin interferencias.
6. **Open Source:** Licencia MIT, repositorio público y README con instrucciones de despliegue y guía de arquitectura para escalar a 30 escenarios en simultáneo.

---

## 2. Diagrama de Arquitectura Multisesión (Nerdearla Scale)

```text
ESCENARIO 1 (main-stage)                      ESCENARIO 2 (ai-stage)
Speaker / Audio Sample (EN)                   Speaker / Audio Sample (EN)
        │                                             │
        ▼                                             ▼
[Cloud Run: Pipeline 1]                       [Cloud Run: Pipeline 2]
  ├── Gemini Transcribe Live                    ├── Gemini Transcribe Live
  │     └─► Partial (EN)                              └─► Partial (EN)
  └── Gemini Flash-Lite (Translate)             └── Gemini Flash-Lite (Translate)
        └─► Final (ES)                                └─► Final (ES)
        │                                             │
        ▼                                             ▼
  RTDB: /liveSessions/main-stage                RTDB: /liveSessions/ai-stage
        │                                             │
        ├──────────────────────┐                      ├──────────────────────┐
        ▼                      ▼                      ▼                      ▼
  AUDIENCIA 1            AUDIENCIA 500          AUDIENCIA 1            AUDIENCIA 800
  (EN / ES)              (EN / ES)              (EN / ES)              (EN / ES)
```

---

## 3. Especificaciones del Core MVP

### 3.1. Ingesta Dual: Micrófono o Audio de Prueba
- **Modo Micrófono:** `AudioWorklet` con `StreamingPCMResampler` (16kHz Int16 Mono Little-Endian).
- **Modo Audio de Prueba:** Transmisión de un archivo `.wav` / `.mp3` de una charla real de Nerdearla, troceado en chunks de 100ms para emular un speaker en vivo.

### 3.2. Transcripción Live (`gemini-3.5-transcribe-live`)
- Transcripción rápida de baja latencia con `customVocabulary` técnico:
  `["Nerdearla", "Kubernetes", "TypeScript", "React", "Cloud Run", "Gemini", "A-TEAM"]`.
- `interimInputTranscription` ➔ Publica al instante en `/liveSessions/:id/current/partialText`.

### 3.3. Traducción Simultánea (`gemini-3.5-flash-lite`)
- En cuanto se recibe un `inputTranscription` consolidado:
  - Se despacha la traducción a español con latencia ~300-500ms.
  - Prompt estricto: *"Translate the following conference subtitle to Spanish. Preserve technical terms, software names, and product names verbatim. Return ONLY the translation."*
  - Se publica en `/liveSessions/:id/translations/es`.

### 3.4. Multi-Sesión Simultánea
- Backend gestiona instancias independientes por cada `sessionId`:
  - `main-stage`
  - `ai-stage`
- La audiencia en `/` puede elegir qué sala ver, o entrar directo a `/session/main-stage` y `/session/ai-stage`.

---

## 4. Plan de Ejecución para la Entrega

- [x] **Paso 1:** Scaffolding inicial, Git y configuración Firebase (`voicy-live`).
- [x] **Paso 2:** AudioWorklet `StreamingPCMResampler` con chunks de 100ms.
- [x] **Paso 3:** Conexión WebSocket a `gemini-3.5-transcribe-live` (Watchdog + límite 10 min + vocabulary).
- [ ] **Paso 4:** Módulo de Traducción EN ➔ ES con `gemini-3.5-flash-lite` en `backend/src/Translator.js`.
- [ ] **Paso 5:** Audio de Prueba (Sample Audio Streamer) en el Broadcaster para evaluación con 1 clic.
- [ ] **Paso 6:** Selector de idioma `[ ORIGINAL ]` / `[ ESPAÑOL ]` en la vista de audiencia `/session/:id`.
- [ ] **Paso 7:** Validación simultánea de 2 salas (`main-stage` y `ai-stage`).
- [ ] **Paso 8:** Licencia MIT y `README.md` completo con explicación de arquitectura para escalar a 30 salas.
