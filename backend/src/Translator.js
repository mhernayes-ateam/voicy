/**
 * Translator (Gemini Flash) - Bidireccional Inteligente (EN ➔ ES / ES ➔ EN)
 * 
 * Cumple con el requisito opcional valorado de Nerdearla:
 * - Si el orador habla en Inglés ➔ Traduce al Español.
 * - Si el orador habla en Español ➔ Traduce al Inglés.
 * - Preserva términos técnicos, marcas y código (Kubernetes, React, Gemini, Nerdearla, etc.).
 */

export class Translator {
  constructor(apiKey) {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY;
  }

  async translateAuto(text) {
    if (!text || !text.trim()) {
      return { text: '', sourceLang: 'en', targetLang: 'es' };
    }

    if (!this.apiKey) {
      console.warn('[Translator] Sin GEMINI_API_KEY. Usando fallback de desarrollo.');
      return { text: `[TRAD] ${text}`, sourceLang: 'en', targetLang: 'es' };
    }

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.apiKey}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `You are an expert conference simultaneous interpreter for Nerdearla.
Task:
1. Detect if the input sentence is primarily English or Spanish.
2. If it is English, translate it to natural, fluent Latin American Spanish.
3. If it is Spanish, translate it to natural, fluent English.
4. Strictly preserve technical terms, software libraries, product names, code keywords, and brands verbatim (e.g., Kubernetes, React, Gemini, TypeScript, Nerdearla, Cloud Run, Docker).

Format your response as valid JSON:
{
  "translation": "<translated text>",
  "sourceLang": "en" | "es",
  "targetLang": "es" | "en"
}

Input: "${text}"`
            }]
          }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
            maxOutputTokens: 150
          }
        })
      });

      if (!response.ok) {
        console.error(`[Translator] Error en Gemini Flash (${response.status}):`, await response.text());
        return { text: `[TRAD] ${text}`, sourceLang: 'auto', targetLang: 'es' };
      }

      const data = await response.json();
      const rawJson = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      const parsed = JSON.parse(rawJson);

      return {
        text: parsed.translation || text,
        sourceLang: parsed.sourceLang || 'en',
        targetLang: parsed.targetLang || 'es'
      };
    } catch (err) {
      console.error('[Translator] Error en traducción bidireccional:', err.message);
      return { text: `[TRAD] ${text}`, sourceLang: 'auto', targetLang: 'es' };
    }
  }
}
