/**
 * FirebasePublisher
 * 
 * Publica actualizaciones en tiempo real hacia Firebase Realtime Database
 * utilizando la REST API directa para máxima velocidad, cero overhead de autenticación
 * y compatibilidad total tanto local como en producción (Cloud Run).
 */
export class FirebasePublisher {
  constructor(options = {}) {
    this.projectId = options.projectId || process.env.FIREBASE_PROJECT_ID || 'voicy-3fca6';
    this.databaseURL = (options.databaseURL || process.env.FIREBASE_DATABASE_URL || 'https://voicy-3fca6-default-rtdb.firebaseio.com').replace(/\/$/, '');
    this.isInitialized = true;
    console.log(`[FirebasePublisher] RTDB REST Publisher listo para ${this.databaseURL}`);
  }

  async publishPartial(sessionId, payload) {
    try {
      const url = `${this.databaseURL}/liveSessions/${sessionId}.json`;
      const body = {
        status: 'live',
        current: {
          segmentId: payload.segmentId,
          sequence: payload.sequence,
          partialText: payload.partialText,
          updatedAt: payload.updatedAt
        },
        metrics: {
          lastInterimAt: payload.updatedAt
        }
      };

      await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (err) {
      console.error(`[FirebasePublisher] Error publicando partial:`, err.message);
    }
  }

  async publishFinal(sessionId, payload) {
    try {
      const url = `${this.databaseURL}/liveSessions/${sessionId}.json`;
      const body = {
        current: {
          partialText: '',
          updatedAt: payload.updatedAt
        },
        lastFinal: {
          segmentId: payload.segment.segmentId,
          sequence: payload.segment.sequence,
          text: payload.segment.text,
          updatedAt: payload.updatedAt
        }
      };

      await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (err) {
      console.error(`[FirebasePublisher] Error publicando final:`, err.message);
    }
  }

  async publishTranslation(sessionId, payload) {
    try {
      const translationPayload = {
        segmentId: payload.segmentId,
        sequence: payload.sequence,
        sourceLang: payload.sourceLang || 'auto',
        targetLang: payload.targetLang || 'es',
        text: payload.text,
        es: payload.es || payload.text,
        en: payload.en || payload.text,
        pt: payload.pt || payload.text,
        updatedAt: payload.updatedAt
      };

      // Guardar ES, EN y PT en el mapa de traducciones
      const esUrl = `${this.databaseURL}/liveSessions/${sessionId}/translations/es.json`;
      const enUrl = `${this.databaseURL}/liveSessions/${sessionId}/translations/en.json`;
      const ptUrl = `${this.databaseURL}/liveSessions/${sessionId}/translations/pt.json`;
      const activeUrl = `${this.databaseURL}/liveSessions/${sessionId}/activeTranslation.json`;

      fetch(esUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...translationPayload, text: payload.es || payload.text })
      }).catch(() => {});

      fetch(enUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...translationPayload, text: payload.en || payload.text })
      }).catch(() => {});

      fetch(ptUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...translationPayload, text: payload.pt || payload.text })
      }).catch(() => {});

      // Actualizar el puntero activeTranslation
      await fetch(activeUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(translationPayload)
      });
    } catch (err) {
      console.error(`[FirebasePublisher] Error publicando traducción:`, err.message);
    }
  }
}
