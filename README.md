# 🎙️ Voicy — Live Captions Platform
### Transcripción y Traducción Simultánea a Escala para Conferencias
> Proyecto construido para la **Nerdearla Vibeathon 2026** (24 y 25 de septiembre, 2026).  
> Licencia: **MIT (Open Source Initiative)**  
> 📖 **[Documentación Técnica Completa en HTML](https://voicy-ai.web.app/docs)** (`frontend/docs.html`)

---

## 🎯 El Problema que Resuelve
En conferencias masivas como **Nerdearla** se desarrollan más de 30 charlas en simultáneo (muchas en inglés). Las soluciones comerciales tradicionales son caras, requieren operación manual por escenario y no escalan económicamente.

**Voicy** democratiza la accesibilidad en eventos open source mediante una arquitectura desacoplada:
- **1 Stage ➔ 1 Conexión Gemini Live ➔ Distribución vía Firebase Realtime Database ➔ Miles de asistentes concurrentes.**
- Transcripción del idioma original en tiempo real con `gemini-3.5-transcribe-live` (Modo SMART y vocabulario técnico).
- Traducción instantánea al español con `gemini-2.5-flash` / `gemini-3.5-flash-lite`.
- Vista mobile-first para la audiencia donde cada asistente elige la sala y el idioma (`[ ORIGINAL ]` o `[ ESPAÑOL ]`).

---

## 🏗️ Arquitectura de Escala (De 2 a 30+ Escenarios)

```text
ESCENARIO 1 (Main Stage)                  ESCENARIO 2 (AI Stage)              ... ESCENARIO 30
Speaker Mic / Test Sample                 Speaker Mic / Test Sample               Speaker Mic
        │                                         │                                    │
        ▼                                         ▼                                    ▼
[Cloud Run: caption-stream]               [Cloud Run: caption-stream]          [Cloud Run: caption-stream]
  ├── Gemini 3.5 Live (STT)                 ├── Gemini 3.5 Live (STT)            ├── Gemini 3.5 Live (STT)
  └── Gemini Flash (EN➔ES)                  └── Gemini Flash (EN➔ES)             └── Gemini Flash (EN➔ES)
        │                                         │                                    │
        ▼                                         ▼                                    ▼
  RTDB: /liveSessions/main-stage            RTDB: /liveSessions/ai-stage         RTDB: /liveSessions/stage-30
        │                                         │                                    │
        ├──────────────────────┐                  ├──────────────────────┐             │
        ▼                      ▼                  ▼                      ▼             ▼
  AUDIENCIA (Celular)     AUDIENCIA (1.500)  AUDIENCIA (Celular)     AUDIENCIA (800)  AUDIENCIA (Celular)
```

### ¿Por qué escala sin límites?
1. **Gemini nunca atiende a los espectadores:** Cada sala consume exactamente **1 stream de IA** independientemente de si hay 1 o 5.000 personas en la sala.
2. **Distribución masiva por Realtime Database:** Una sola instancia de RTDB en Blaze tolera **200.000 conexiones concurrentes** por segundo con latencia sub-100ms.
3. **Escalado horizontal en Cloud Run:** El servicio `caption-stream` levanta instancias bajo demanda de forma automática por cada sala activa.

---

## 🚀 Cómo Ejecutar el Proyecto en Local

### Requisitos Previos
- Node.js 20+
- Una API Key de Google Gemini con acceso a Live API

### 1. Clonar e Instalar Dependencias
```bash
git clone https://github.com/mhernayes-ateam/voicy.git
cd voicy/backend
npm install
```

### 2. Configurar Variables de Entorno
Crea tu archivo `.env` en la carpeta `backend/`:
```bash
cp .env.example .env
```
Edita `.env` y coloca tu clave de Gemini:
```env
GEMINI_API_KEY=tu_api_key_de_gemini_aqui
PORT=8080
```

### 3. Iniciar el Servidor de Transcripción
```bash
npm start
```
El servicio estará escuchando en `http://localhost:8080` (WebSocket en `/ws/broadcast/:sessionId`).

### 4. Servir la Aplicación Web (Frontend)
En otra terminal, corre un servidor estático para la carpeta `frontend/`:
```bash
npx serve frontend -p 3000
```

### 5. Probar el Flujo End-to-End
1. **Panel del Speaker:** Abre en tu navegador `http://localhost:3000/broadcast/main-stage`.
   - Puedes usar tu **micrófono** o seleccionar **Audio de Prueba**.
   - Haz clic en **START LIVE**.
2. **Vista de la Audiencia:** Abre en otra pestaña (o en tu celular) `http://localhost:3000/session/main-stage`.
   - Alterna entre `[ ORIGINAL ]` y `[ ESPAÑOL ]`.
   - Verás la transcripción y la traducción fluir con latencia menor a 1.5 segundos.
3. **Multi-Sesión Simultánea:**
   - Abre `http://localhost:3000/broadcast/ai-stage` y `http://localhost:3000/session/ai-stage` para validar dos salas corriendo en paralelo.

---

## 💎 Características Clave

- **AudioWorklet Resampler Stateful:** Remuestreo acústico continuo de 44.1/48kHz a 16kHz Int16 Mono Little-Endian en chunks de 100 ms (1.600 muestras = 3.200 bytes) sin clics ni pérdida de muestras.
- **Detección Nativa de Turnos:**
  - `interimInputTranscription` para hipótesis de baja latencia (`partialLatencyMs < 1.5s`).
  - `inputTranscription` autoritativo para consolidar frases completas (`finalLatencyMs < 3.0s`).
- **Glosario Técnico Nativo (`customVocabulary`):** Vocabulario precargado con términos clave de conferencias (`Nerdearla`, `Kubernetes`, `TypeScript`, `React`, `Cloud Run`, `Gemini`, `A-TEAM`).
- **Session Resumption & Rotación Preventiva:** Soporta conferencias de 45–60 minutos rotando de forma transparente la sesión de Gemini a los 9 minutos sin alterar la secuencia global de la audiencia.

---

## 📄 Licencia
Este proyecto es software libre distribuido bajo la [Licencia MIT](LICENSE).
