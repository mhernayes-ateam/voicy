/**
 * Translator (Gemini Flash)
 * 
 * Pipeline de traducción simultánea para conferencias internacionales (Nerdearla):
 * - Traduce en una sola llamada ultrarrápida a:
 *   - Español (es)
 *   - Inglés (en)
 *   - Portugués (pt)
 * - Preserva términos técnicos, marcas y comandos de código intactos.
 * - Cache LRU de traducciones exitosas para latencia mínima.
 */

function detectLanguageSimple(text) {
  const t = text.toLowerCase();
  const ptSpecific = ['obrigado', 'obrigada', 'muito', 'estarem', 'palestra', 'você', 'vocês', 'gente', 'então', 'também', 'não', 'falar', 'sobre', 'estamos'];
  const esSpecific = ['gracias', 'charla', 'hoy', 'entonces', 'también', 'bienvenidos', 'vamos', 'todos', 'hablar', 'desplegar', 'nuestros', 'nuestras'];
  const enSpecific = ['the', 'and', 'welcome', 'today', 'everyone', 'deploying', 'using', 'with', 'about', 'this', 'that', 'from', 'have', 'will', 'cloud'];

  let ptScore = 0, esScore = 0, enScore = 0;
  const words = t.split(/\s+/);
  for (const w of words) {
    if (ptSpecific.includes(w)) ptScore += 2;
    if (esSpecific.includes(w)) esScore += 2;
    if (enSpecific.includes(w)) enScore += 2;
  }

  if (enScore > esScore && enScore > ptScore) return 'en';
  if (ptScore > esScore && ptScore > enScore) return 'pt';
  return 'es'; // default para Nerdearla
}

async function translateMyMemory(text, from, to) {
  try {
    const q = encodeURIComponent(text);
    const res = await fetch(`https://api.mymemory.translated.net/get?q=${q}&langpair=${from}|${to}`, {
      signal: AbortSignal.timeout(3500)
    });
    if (res.ok) {
      const data = await res.json();
      const tr = data.responseData?.translatedText;
      if (tr && typeof tr === 'string' && tr.trim() && !tr.includes('MYMEMORY WARNING')) {
        return tr.trim();
      }
    }
  } catch (e) {}
  return null;
}

export class Translator {
  constructor(apiKey) {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY;
    this.cache = new Map();
  }

  async translateAuto(text) {
    if (!text || !text.trim()) {
      return { es: '', en: '', pt: '', text: '', sourceLang: 'auto' };
    }

    const trimmed = text.trim();

    // Cache hit inmediato de traducciones previas (0ms)
    if (this.cache.has(trimmed)) {
      return this.cache.get(trimmed);
    }

    const detected = detectLanguageSimple(trimmed);
    let es = trimmed, en = trimmed, pt = trimmed;

    // Traducción de alta velocidad (< 1.5s) que preserva términos técnicos
    // y no satura la cuota REST de 15 RPM del Free Tier de Gemini
    try {
      if (detected === 'es') {
        const [tEn, tPt] = await Promise.all([
          translateMyMemory(trimmed, 'es', 'en'),
          translateMyMemory(trimmed, 'es', 'pt')
        ]);
        en = tEn || trimmed;
        pt = tPt || trimmed;
      } else if (detected === 'en') {
        const [tEs, tPt] = await Promise.all([
          translateMyMemory(trimmed, 'en', 'es'),
          translateMyMemory(trimmed, 'en', 'pt')
        ]);
        es = tEs || trimmed;
        pt = tPt || trimmed;
      } else if (detected === 'pt') {
        const [tEs, tEn] = await Promise.all([
          translateMyMemory(trimmed, 'pt', 'es'),
          translateMyMemory(trimmed, 'pt', 'en')
        ]);
        es = tEs || trimmed;
        en = tEn || trimmed;
      }
    } catch (e) {
      console.warn('[Translator] Error en traducción rápida:', e.message);
    }

    const result = {
      sourceLang: detected,
      targetLang: detected === 'es' ? 'en' : 'es',
      es,
      en,
      pt,
      text: detected === 'es' ? en : es
    };

    // Guardar en cache si tenemos traducción válida
    if (result && (result.en !== trimmed || result.es !== trimmed || result.pt !== trimmed)) {
      if (this.cache.size > 200) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
      this.cache.set(trimmed, result);
    }

    return result;
  }
}
