// ─── CRBRO Query Tokenizer ───────────────────────────────────────
// Splits a query into meaningful terms. Spanish-first, English-aware.
//
// Deliberately NO stemming. Orama applies its stemmer *before* stripping
// diacritics, so a Spanish stemmer mangles the very common "-ción" family
// (información, configuración, aplicación, integración). Measured on the
// reference brain: 24% of facts contain a "-ción" word and they retrieve
// correctly today. Ablation also showed removing the stemmer *raises* MRR.

/**
 * Words that carry no retrieval signal. Kept short on purpose: an
 * over-eager stoplist silently deletes terms the user meant.
 */
const STOPWORDS = new Set([
  // Spanish
  'a', 'al', 'algo', 'ante', 'aqui', 'asi', 'con', 'como', 'cual', 'cuando',
  'de', 'del', 'desde', 'donde', 'dos', 'el', 'ella', 'ellos', 'en', 'entre',
  'era', 'es', 'esa', 'ese', 'eso', 'esta', 'este', 'esto', 'estos', 'fue',
  'ha', 'hay', 'la', 'las', 'le', 'les', 'lo', 'los', 'mas', 'me', 'mi', 'muy',
  'ni', 'no', 'nos', 'o', 'para', 'pero', 'por', 'que', 'se', 'ser', 'si',
  'sin', 'sobre', 'su', 'sus', 'tan', 'te', 'tiene', 'todo', 'tu', 'un', 'una',
  'uno', 'unos', 'unas', 'y', 'ya',
  // English
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has',
  'have', 'how', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the',
  'their', 'then', 'there', 'these', 'this', 'to', 'was', 'were', 'what',
  'when', 'where', 'which', 'who', 'why', 'with',
]);

/**
 * Fold accents so "participación" and "participacion" are the same term.
 * Keeps ñ as n — Spanish users type it both ways.
 */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Split text into terms. Keeps underscores and digits together so
 * identifiers survive intact ("ocultar_de_lista", "wp_wppc_entries", "6698").
 */
export function tokenize(text: string): string[] {
  return fold(text)
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
}

/**
 * Tokenize a search query: drop stopwords and 1-char noise, dedupe,
 * and keep the original order. If everything was a stopword, fall back
 * to the raw tokens — an empty term list would return nothing at all.
 */
export function queryTerms(query: string): string[] {
  const raw = tokenize(query);
  const kept: string[] = [];
  const seen = new Set<string>();

  for (const t of raw) {
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    kept.push(t);
  }

  if (kept.length > 0) return kept;

  // Everything filtered out — use whatever we had, deduped.
  const fallback: string[] = [];
  for (const t of raw) {
    if (!fallback.includes(t)) fallback.push(t);
  }
  return fallback;
}

export { STOPWORDS };
