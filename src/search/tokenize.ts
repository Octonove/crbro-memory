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

import { SYNONYMS } from './synonyms.js';

/** The synonym table is on unless CRBRO_SYNONYMS=0 — the benchmark runs both. */
export function synonymsEnabled(): boolean {
  return process.env.CRBRO_SYNONYMS !== '0';
}

/**
 * Other spellings of the same query term: singular/plural, and the curated
 * bilingual synonyms in synonyms.ts. Every variant counts as the SAME term,
 * so coverage stays honest — a question about "facturas" does not score
 * twice for also matching "factura", and "alojamiento" scores exactly like
 * "hosting" would have.
 *
 * Deliberately NOT a stemmer: applied to Spanish it mangles the very common
 * -ción family. And the synonym table is a fixed list, not an inference —
 * it can widen the spelling of a term that was asked for, never add one
 * that was not. Measured on the blind retrieval benchmark in benchmarks/;
 * the honest caveat about who wrote the table is recorded there.
 */
export function variants(term: string): string[] {
  const out = new Set<string>([term]);
  if (synonymsEnabled()) {
    for (const s of SYNONYMS[term] || []) out.add(s);
  }
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
