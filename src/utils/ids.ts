// ─── CRBRO ID Utilities ──────────────────────────────────────────
// Generate and validate neuron/synapse IDs

import { createHash } from 'node:crypto';
import type { NeuronType } from '../types/index.js';

const TYPE_PREFIXES: Record<NeuronType, string> = {
  project: 'project_',
  tech: 'tech_',
  lang: 'lang_',
  person: 'person_',
  domain: 'domain_',
  process: 'process_',
  protocol: 'protocol_',
};

/**
 * Names whose punctuation IS the identity. Without this, "C", "C++" and "C#"
 * all slugged to "c" and shared one neuron. Applied before anything else, as
 * whole words only, so "c++ tips" maps and "abc++" does not.
 */
const SYMBOL_WORDS: Array<[RegExp, string]> = [
  [/(^|[^\p{L}\p{N}])c\+\+(?![\p{L}\p{N}])/giu, '$1cpp'],
  [/(^|[^\p{L}\p{N}])c#(?![\p{L}\p{N}])/giu, '$1csharp'],
  [/(^|[^\p{L}\p{N}])f#(?![\p{L}\p{N}])/giu, '$1fsharp'],
];

function mapSymbolWords(str: string): string {
  let out = str;
  for (const [re, to] of SYMBOL_WORDS) out = out.replace(re, to);
  return out;
}

/** Latin letters NFD does not decompose: they used to vanish ("Straße" → "strae"). */
const LATIN_EXTRA: Record<string, string> = {
  'ß': 'ss', 'ẞ': 'ss', 'ø': 'o', 'Ø': 'o', 'ł': 'l', 'Ł': 'l', 'đ': 'd', 'Đ': 'd', 'ð': 'd', 'Ð': 'd',
  'þ': 'th', 'Þ': 'th', 'æ': 'ae', 'Æ': 'ae', 'œ': 'oe', 'Œ': 'oe', 'ı': 'i', 'ħ': 'h', 'Ħ': 'h',
};

/** Trivial one-to-one transliteration: Greek and Cyrillic. Anything else is hashed. */
const TRANSLIT: Record<string, string> = (() => {
  const t: Record<string, string> = {};
  const cyr = 'а:a б:b в:v г:g д:d е:e ё:e ж:zh з:z и:i й:y к:k л:l м:m н:n о:o п:p р:r с:s т:t у:u ф:f х:kh ц:ts ч:ch ш:sh щ:shch ъ: ы:y ь: э:e ю:yu я:ya і:i ї:yi є:ye ґ:g ў:u';
  const gre = 'α:a β:v γ:g δ:d ε:e ζ:z η:i θ:th ι:i κ:k λ:l μ:m ν:n ξ:x ο:o π:p ρ:r σ:s ς:s τ:t υ:y φ:f χ:ch ψ:ps ω:o';
  for (const pair of `${cyr} ${gre}`.split(' ')) {
    const [k, v] = pair.split(':');
    t[k] = v;
  }
  return t;
})();

function transliterate(str: string): string {
  let out = '';
  for (const ch of str) {
    const lower = ch.toLowerCase();
    if (LATIN_EXTRA[ch] !== undefined) out += LATIN_EXTRA[ch];
    else if (TRANSLIT[lower] !== undefined) out += TRANSLIT[lower];
    else out += ch;
  }
  return out;
}

/** The 2.10 algorithm, kept as a lookup fallback: neurons created by it live under its slugs. */
function slug210(str: string): string {
  return str
    .normalize('NFD')                 // Split accents off their letters...
    .replace(/[\u0300-\u036f]/g, '')   // ...and drop the accents, keeping the letter
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s_-]/g, '')     // Remove what is left that we cannot use
    .replace(/[\s-]+/g, '_')           // Spaces/hyphens to underscores
    .replace(/_+/g, '_')               // Collapse multiple underscores
    .replace(/^_|_$/g, '');            // Trim leading/trailing underscores
}

/**
 * Convert a string to a valid snake_case ID.
 * "OctoChat Plugin" → "octochat_plugin"
 *
 * Never empty for a name that has any character in it: a name whose letters
 * are not Latin (and not trivially transliterable) gets a short stable hash of
 * the whole name, so "東京" and "大阪" are two neurons, not one called
 * "project_" that every such topic fell into.
 */
export function toSnakeCase(str: string): string {
  return slugOf(str).slug;
}

function slugOf(str: string): { slug: string; hashed: boolean } {
  const raw = (str || '').trim();
  if (!raw) return { slug: '', hashed: false };
  const folded = mapSymbolWords(raw).normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
  const prepared = transliterate(folded);
  const base = slug210(prepared);
  // Letters or digits that are still not a-z/0-9 were dropped by slug210:
  // their information must not be lost, or two names differing only there
  // would collide.
  const lost = /[^\x00-\x7f]/.test(prepared.replace(/[^\p{L}\p{N}]/gu, ''));
  if (base && !lost) return { slug: base, hashed: false };
  const hash = createHash('sha1').update(raw.normalize('NFC').toLowerCase(), 'utf8').digest('hex').slice(0, 8);
  return { slug: base ? `${base}_u${hash}` : `u${hash}`, hashed: true };
}

/**
 * Every slug an existing neuron for this name may be filed under, newest rule
 * first: the current one, the 2.10 one, and the pre-1.x accent-mangling one.
 * The older two are computed on the symbol-mapped name, so "C++" never falls
 * back to the "c" that 2.10 gave it — that fallback is exactly the merge the
 * new rule exists to stop. Nor does a name the new rule had to hash: 2.10
 * dropped its letters, so its old slug is shared by unrelated names.
 */
export function slugCandidates(name: string): string[] {
  const out: string[] = [];
  const add = (s: string) => { if (s && !out.includes(s)) out.push(s); };
  const actual = slugOf(name);
  add(actual.slug);
  if (actual.hashed) return out;
  const mapped = mapSymbolWords((name || '').trim());
  add(slug210(mapped));
  add(legacySnakeCase(mapped));
  return out;
}

/**
 * How ids were built before accents were folded: the accented letter was
 * deleted whole, so "búsqueda" became "bsqueda" and "técnico" became "tcnico".
 * On the reference brain that mangled 82 of 1,183 ids.
 *
 * Kept because those neurons exist on disk under the mangled name and must
 * stay reachable. Lookups try the correct slug first and fall back to this.
 */
export function legacySnakeCase(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Generate a neuron ID from name and type.
 * ("OctoChat", "project") → "project_octochat"
 */
export function neuronId(name: string, type: NeuronType): string {
  const prefix = TYPE_PREFIXES[type];
  let slug = toSnakeCase(name);
  // A name that already is an id of this type ("project_x") keeps its one
  // prefix: it used to become "project_project_x".
  if (slug.startsWith(prefix) && slug.length > prefix.length) slug = slug.slice(prefix.length);
  return `${prefix}${slug}`;
}

/** The type an id-shaped slug names ("tech_react" → tech), or null. */
export function typeOfIdShape(slug: string): NeuronType | null {
  for (const [type, prefix] of Object.entries(TYPE_PREFIXES) as Array<[NeuronType, string]>) {
    if (slug.startsWith(prefix) && slug.length > prefix.length) return type;
  }
  return null;
}

/**
 * Generate a synapse ID from two neuron IDs.
 * ("project_octochat", "tech_firebase") → "syn_octochat__firebase"
 * Always sorted alphabetically for consistency.
 */
export function synapseId(nodeA: string, nodeB: string): string {
  const stripPrefix = (id: string) => id.replace(/^(project_|tech_|lang_|person_|domain_|process_)/, '');
  const parts = [stripPrefix(nodeA), stripPrefix(nodeB)].sort();
  return `syn_${parts[0]}__${parts[1]}`;
}

/**
 * Generate a session ID for today.
 * → "session_2026-05-06"
 */
export function sessionId(date?: string): string {
  const d = date || new Date().toISOString().split('T')[0];
  return `session_${d}`;
}

/**
 * Validate that a string is a valid neuron ID.
 */
export function isValidNeuronId(id: string): boolean {
  return /^(project|tech|lang|person|domain|process|protocol)_[a-z0-9_]+$/.test(id);
}

const TECH_KEYWORDS = ['firebase', 'react', 'node', 'docker', 'kubernetes', 'aws', 'gcp', 'cloud', 'api', 'rest',
  'graphql', 'mongodb', 'postgres', 'redis', 'nginx', 'webpack', 'vite', 'git', 'npm', 'supabase', 'stripe',
  'vercel', 'netlify', 'cloudflare', 'orama', 'chromadb', 'openai', 'gemini', 'claude'];

/**
 * The first technology a text names as a whole word ("git", "firebase"), or
 * null. Whole words on purpose: inferNeuronType's substring test is fine for
 * a topic name and wrong for a sentence ("rest" inside "interesting").
 */
export function techKeywordIn(text: string): string | null {
  const words = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  return TECH_KEYWORDS.find(kw => words.has(kw)) ?? null;
}

/**
 * Infer neuron type from topic name using simple heuristics.
 * Falls back to 'project' if unsure.
 *
 * Whole words only (accents folded). Substrings sent "Juego Onoris Lanista"
 * to lang_ ("go "), "PAGO UNICO" too, and anything "digital" to tech_ ("git").
 * The type is the id prefix, so a wrong guess is a wrong identity.
 */
export function inferNeuronType(topic: string): NeuronType {
  const folded = (topic || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const words = new Set(folded.split(/[^a-z0-9]+/).filter(Boolean));
  const has = (kw: string) => words.has(kw);

  // Tech keywords
  if (TECH_KEYWORDS.some(has)) return 'tech';

  // Language keywords
  const langKeywords = ['python', 'javascript', 'typescript', 'php', 'rust', 'go', 'golang', 'java', 'swift', 'kotlin', 'css', 'html', 'sql'];
  if (langKeywords.some(has)) return 'lang';

  // Process keywords
  const processKeywords = ['deploy', 'migration', 'workflow', 'pipeline', 'backup', 'setup', 'install'];
  if (processKeywords.some(has) || /(^|[^a-z0-9])ci\/cd([^a-z0-9]|$)/.test(folded)) return 'process';

  // Domain keywords
  const domainKeywords = ['seo', 'marketing', 'trading', 'crypto', 'design', 'security', 'devops', 'data', 'analytics'];
  if (domainKeywords.some(kw => folded === kw)) return 'domain';

  // Protocol keywords. "protocolo" keeps working: a Spanish protocol neuron
  // is injected at boot, and the substring rule always caught it.
  const protocolKeywords = ['protocol', 'protocols', 'protocolo', 'protocolos', 'directive', 'directives', 'directiva', 'directivas',
    'rule', 'rules', 'enforcement', 'behavioral'];
  if (protocolKeywords.some(has)) return 'protocol';

  // Default to project
  return 'project';
}
