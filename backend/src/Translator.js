/**
 * Translator (Gemini Flash-Lite)
 * 
 * Traduce segmentos definitivos de inglés a español en tiempo real.
 * Utiliza llamadas HTTP ultrarrápidas con instrucciones concisas para preservar
 * terminología técnica, nombres de productos y marcas (Nerdearla, Kubernetes, React, etc.).
 */

export class Translator {
  constructor(apiKey) {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY;
  }

  async translateToSpanish(text) {
    if (!text || !text.trim()) return '';
    if (!this.apiKey) {
      console.warn('[Translator] Sin GEMINI_API_KEY. Usando traducción de respaldo.');
      return `[ES] ${text}`;
    }

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.apiKey}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `You are an expert conference simultaneous interpreter. Translate the following English speech segment to fluent Spanish.
Rules:
- Preserve technical terms, product names, code keywords, and brands verbatim (e.g. Kubernetes, React, Gemini, Nerdearla, Cloud Run, TypeScript).
- Output ONLY the translated Spanish sentence. Do not add quotes, explanations, or prefixes.

English: "${text}"`
            }]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 120
          }
        })
      });

      if (!response.ok) {
        console.error(`[Translator] Error en Gemini Flash (${response.status}):`, await response.text());
        return `[ES] ${text}`;
      }

      const data = await response.json();
      const translation = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      return translation || `[ES] ${text}`;
    } catch (err) {
      console.error('[Translator] Excepción traduciendo segmento:', err.message);
      return `[ES] ${text}`;
    }
  }
}
