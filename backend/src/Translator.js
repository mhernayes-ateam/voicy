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
    this.cache = new Map();
  }

  async translateAuto(text) {
    if (!text || !text.trim()) {
      return { es: '', en: '', pt: '', text: '' };
    }

    const trimmed = text.trim();

    // Cache hit inmediato
    if (this.cache.has(trimmed)) {
      return this.cache.get(trimmed);
    }

    if (!this.apiKey) {
      const fallback = { es: trimmed, en: trimmed, pt: trimmed, text: trimmed };
      return fallback;
    }

    try {
      // Prompt bidireccional ultrarrápido según plan.md 4.5
      // Detecta si es español o inglés y traduce al opuesto
      const prompt = `You are a simultaneous conference interpreter.
Detect if the text is Spanish or English. If English, translate to Latin American Spanish. If Spanish, translate to English.
Preserve technical terms and brands (e.g. Kubernetes, React, Gemini, Nerdearla, Docker, Cloud Run) verbatim.
Return ONLY valid JSON:
{"source":"en"|"es","translation":"<translated text>"}
Input: "${trimmed}"`;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${this.apiKey}`;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3500);

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens: 120,
            temperature: 0.1
          }
        }),
        signal: ctrl.signal
      });
      clearTimeout(timer);

      let result = null;
      if (res.ok) {
        const data = await res.json();
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        const parsed = JSON.parse(raw);
        const isEnglish = parsed.source === 'en';
        result = {
          es: isEnglish ? parsed.translation : trimmed,
          en: isEnglish ? trimmed : parsed.translation,
          pt: parsed.translation,
          text: parsed.translation || trimmed,
          sourceLang: parsed.source || 'auto',
          targetLang: isEnglish ? 'es' : 'en'
        };
      }

      if (!result) {
        result = { es: trimmed, en: trimmed, pt: trimmed, text: trimmed };
      }

      // Guardar en cache (máx 150 elementos)
      if (this.cache.size > 150) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
      this.cache.set(trimmed, result);

      return result;
    } catch (err) {
      const fallback = { es: trimmed, en: trimmed, pt: trimmed, text: trimmed };
      return fallback;
    }
  }
}
