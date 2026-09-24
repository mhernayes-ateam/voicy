/**
 * Translator (Gemini Flash)
 * 
 * Pipeline de traducción simultánea para conferencias internacionales (Nerdearla):
 * - Traduce en una sola llamada ultrarrápida a:
 *   - Español (es)
 *   - Inglés (en)
 *   - Portugués (pt)
 * - Preserva términos técnicos y marcas intactos.
 * - Cola de concurrencia y cache LRU para latencia mínima.
 */

export class Translator {
  constructor(apiKey) {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY;
    this.isTranslating = false;
    this.cache = new Map();
  }

  async translateAuto(text) {
    if (!text || !text.trim()) {
      return { es: '', en: '', pt: '', text: '' };
    }

    const trimmed = text.trim();

    // Cache hit
    if (this.cache.has(trimmed)) {
      return this.cache.get(trimmed);
    }

    if (!this.apiKey) {
      const fallback = {
        es: trimmed,
        en: trimmed,
        pt: trimmed,
        text: trimmed
      };
      return fallback;
    }

    // Esperar si hay una traducción activa (cola de 1 en vuelo para prevenir 503)
    let attempts = 0;
    while (this.isTranslating && attempts < 10) {
      await new Promise(r => setTimeout(r, 60));
      attempts++;
    }

    this.isTranslating = true;

    try {
      const prompt = `You are an expert conference interpreter for Nerdearla.
Task: Translate the given input speech into Spanish (es), English (en), and Portuguese (pt).
Strictly preserve technical terms, software libraries, product names, code keywords, and brands (e.g. Kubernetes, Gemini, React, Docker, Nerdearla, Voicy, Cloud Run, Python) verbatim.
Return ONLY valid JSON with keys "es", "en", "pt":
Input: "${trimmed}"`;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${this.apiKey}`;

      let result = null;
      for (let retry = 0; retry < 2; retry++) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                responseMimeType: 'application/json',
                maxOutputTokens: 250,
                temperature: 0.1
              }
            })
          });

          if (res.ok) {
            const data = await res.json();
            const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
            const parsed = JSON.parse(raw);
            result = {
              es: parsed.es || trimmed,
              en: parsed.en || trimmed,
              pt: parsed.pt || trimmed,
              text: parsed.es || trimmed
            };
            break;
          } else {
            await new Promise(r => setTimeout(r, 200));
          }
        } catch (netErr) {
          await new Promise(r => setTimeout(r, 200));
        }
      }

      if (!result) {
        result = {
          es: trimmed,
          en: trimmed,
          pt: trimmed,
          text: trimmed
        };
      }

      // Guardar en cache (máx 150 elementos)
      if (this.cache.size > 150) {
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
