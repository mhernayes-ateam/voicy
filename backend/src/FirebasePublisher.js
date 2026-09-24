import admin from 'firebase-admin';

/**
 * FirebasePublisher
 * 
 * Publica actualizaciones en tiempo real hacia Firebase Realtime Database.
 * Incluye modo fallback in-memory para desarrollo local antes de configurar serviceAccountKey.
 */
export class FirebasePublisher {
  constructor(options = {}) {
    this.projectId = options.projectId || process.env.FIREBASE_PROJECT_ID || 'voicy-live';
    this.databaseURL = options.databaseURL || process.env.FIREBASE_DATABASE_URL || 'https://voicy-live-default-rtdb.firebaseio.com';
    this.rtdb = null;
    this.isInitialized = false;

    this.init();
  }

  init() {
    try {
      if (!admin.apps.length) {
        // Si hay credenciales de aplicación o se ejecuta en Cloud Run con IAM
        admin.initializeApp({
          projectId: this.projectId,
          databaseURL: this.databaseURL
        });
      }
      this.rtdb = admin.database();
      this.isInitialized = true;
      console.log(`[FirebasePublisher] Firebase Admin inicializado para ${this.projectId} (${this.databaseURL})`);
    } catch (err) {
      console.warn(`[FirebasePublisher] Modo emulación local activo (sin credenciales de Firebase Admin):`, err.message);
      this.isInitialized = false;
    }
  }

  async publishPartial(sessionId, payload) {
    if (!this.isInitialized || !this.rtdb) {
      return;
    }

    try {
      const ref = this.rtdb.ref(`liveSessions/${sessionId}`);
      await ref.update({
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
      });
    } catch (err) {
      console.error(`[FirebasePublisher] Error publicando partial en RTDB:`, err.message);
    }
  }

  async publishFinal(sessionId, payload) {
    if (!this.isInitialized || !this.rtdb) {
      return;
    }

    try {
      const ref = this.rtdb.ref(`liveSessions/${sessionId}`);
      await ref.update({
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
      });
    } catch (err) {
      console.error(`[FirebasePublisher] Error publicando final en RTDB:`, err.message);
    }
  }
}
