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

/**
 * Singular and plural of the same word, so a query about "facturas" still
 * finds the fact that says "factura".
 *
 * Deliberately NOT a stemmer and NOT a synonym table. A stemmer applied to
 * Spanish mangles the very common -ción family; a synonym table is guesswork
 * that quietly pulls in wrong results. Number agreement is mechanical, covers
 * a large share of real misses, and cannot invent a meaning that was not there.
 */
export function variants(term: string): string[] {
  const out = new Set<string>([term]);
  if (term.length < 4) return [...out];

  // Plural -> singular
  if (term.endsWith('ces')) out.add(term.slice(0, -3) + 'z');   // luces -> luz
  if (term.endsWith('es')) out.add(term.slice(0, -2));          // papeles -> papel
  if (term.endsWith('ies')) out.add(term.slice(0, -3) + 'y');   // policies -> policy
  if (term.endsWith('s')) out.add(term.slice(0, -1));           // datos -> dato

  // Singular -> plural
  if (!term.endsWith('s')) {
    out.add(term + 's');
    if (/[bcdfglmnprstz]$/.test(term)) out.add(term + 'es');    // papel -> papeles
  }

  // Two more folds were tried against the blind retrieval benchmark
  // (24-08-2026) and neither ships. A participle gender fold (-adas ->
  // -ado) left every metric exactly unchanged (56/69/0.634), and a verb
  // person fold (-o <-> -a/-an) made them WORSE (54/67/0.614) — the extra
  // variants pulled noise above real hits. The remaining recall misses are
  // true synonym gaps (hosting/alojamiento, seguridad/protección), which no
  // mechanical rule closes; that is the documented price of not shipping a
  // semantic model.

  // Nothing shorter than three letters: "es", "os" and friends are noise.
  return [...out].filter(v => v.length >= 3);
}

export { STOPWORDS };
