/**
 * Translator (Gemini Flash)
 * 
 * Pipeline de traducción ultrarrápido y robusto para conferencias:
 * - Detecta el idioma del orador (EN o ES).
 * - Genera siempre versiones en Español e Inglés.
 * - Evita saturación con cola de concurrencia y reintentos automáticos.
 * - Cero fallos por JSON schemas complejos.
 */

const spanishMarkers = /\b(el|la|los|las|un|una|unos|unas|de|del|en|para|por|con|que|es|son|hola|buenos|dias|tardes|noches|bienvenidos|gracias|estamos|charla|escenario|conferencia|subtítulos|traducción|como|están|vamos|hacer|hoy|aquí)\b/i;

export class Translator {
  constructor(apiKey) {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY;
    this.isTranslating = false;
    this.cache = new Map();
  }

  detectLanguage(text) {
    return spanishMarkers.test(text) ? 'es' : 'en';
  }

  async translateAuto(text) {
    if (!text || !text.trim()) {
      return { sourceLang: 'en', targetLang: 'es', es: '', en: '', text: '' };
    }

    const trimmed = text.trim();

    // Cache hit
    if (this.cache.has(trimmed)) {
      return this.cache.get(trimmed);
    }

    const sourceLang = this.detectLanguage(trimmed);
    const targetLang = sourceLang === 'es' ? 'en' : 'es';
    const targetLangName = sourceLang === 'es' ? 'English' : 'Spanish';

    if (!this.apiKey) {
      const fallback = {
        sourceLang,
        targetLang,
        es: sourceLang === 'es' ? trimmed : `[ES] ${trimmed}`,
        en: sourceLang === 'en' ? trimmed : `[EN] ${trimmed}`,
        text: trimmed
      };
      return fallback;
    }

    // Esperar si hay una traducción activa (cola de 1 en vuelo para evitar 503)
    let attempts = 0;
    while (this.isTranslating && attempts < 10) {
      await new Promise(r => setTimeout(r, 80));
      attempts++;
    }

    this.isTranslating = true;

    try {
      const prompt = `Translate the following conference speech to ${targetLangName}. Strictly preserve technical names and brands (Kubernetes, Gemini, Nerdearla, React, Docker, Cloud Run, Python) verbatim. Return ONLY the translated sentence with no explanations or punctuation changes:\n\n${trimmed}`;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${this.apiKey}`;

      let translated = '';
      for (let retry = 0; retry < 2; retry++) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                maxOutputTokens: 250,
                temperature: 0.1
              }
            })
          });

          if (res.ok) {
            const data = await res.json();
            translated = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
            if (translated) break;
          } else {
            console.warn(`[Translator] Intento ${retry + 1} falló con ${res.status}. Reintentando en 250ms...`);
            await new Promise(r => setTimeout(r, 250));
          }
        } catch (netErr) {
          console.warn(`[Translator] Error de red en intento ${retry + 1}:`, netErr.message);
          await new Promise(r => setTimeout(r, 250));
        }
      }

      if (!translated) {
        translated = trimmed;
      }

      const result = {
        sourceLang,
        targetLang,
        es: sourceLang === 'es' ? trimmed : translated,
        en: sourceLang === 'en' ? trimmed : translated,
        text: translated
      };

      // Guardar en cache (máx 100 elementos)
      if (this.cache.size > 100) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
      this.cache.set(trimmed, result);

      return result;
    } finally {
      this.isTranslating = false;
    }
  }
}
