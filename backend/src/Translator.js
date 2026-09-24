/**
 * Translator (Gemini Flash) - Bidireccional Inteligente (EN ➔ ES / ES ➔ EN)
 * 
 * Cumple con el requisito de Nerdearla:
 * - Si el orador habla en Inglés ➔ Traduce al Español neutro/rioplatense profesional.
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
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${this.apiKey}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `You are an expert simultaneous conference interpreter for Nerdearla.
Task:
1. Detect if the input is primarily English or Spanish.
2. If it is English, translate it to natural, fluent Latin American Spanish.
3. If it is Spanish, translate it to natural, fluent English.
4. If ambiguous or mixed, translate to Spanish.
5. Strictly preserve technical terms, software libraries, product names, code keywords, and brands verbatim (e.g., Kubernetes, React, Gemini, TypeScript, Nerdearla, Cloud Run, Docker, AWS, GCP, Python).

Respond ONLY with valid JSON:
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
            maxOutputTokens: 200
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
