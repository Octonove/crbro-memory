// ─── CRBRO Shelf life ────────────────────────────────────────────
//
// How fast a stored value goes stale, and whether it already has. Pure: no
// disk, no clock of its own (the caller passes `nowMs`), so every rule here is
// unit-tested with fixed dates. Design: docs/design/staleness.md.
//
// Four classes, chosen to be easy for a model to pick from the text alone:
//   volatile  — versions, prices, ports and hosts, paths and URLs, config
//               values, who holds a role          (default window: 90 days)
//   normal    — any other fact                    (365 days)
//   durable   — decisions, procedures (patterns)  (730 days)
//   permanent — history: preferences, errors, debts, a fact marked so (never)
//
// The windows are a policy choice, not a measurement: nothing in this
// repository measures how long a port or a price stays true. They are set so
// that volatile warns within a quarter and normal within a year, and can be
// changed per machine with CRBRO_SHELF_DAYS="volatile=90,normal=365,durable=730".
// CRBRO_STALENESS=0 switches the whole feature off.

import type { Fact, Neuron } from '../types/index.js';
import { entryId } from '../sync/ops.js';

export const SHELF_LIVES = ['volatile', 'normal', 'durable', 'permanent'] as const;
export type ShelfLife = typeof SHELF_LIVES[number];
/** The classes that have a window. `permanent` never goes stale. */
export type WindowedShelf = Exclude<ShelfLife, 'permanent'>;
export type ShelfWindows = Record<WindowedShelf, number>;

export const DEFAULT_SHELF_DAYS: Readonly<ShelfWindows> = { volatile: 90, normal: 365, durable: 730 };

const DAY_MS = 86_400_000;

/** Off only when someone said so: CRBRO_STALENESS=0 (or false/off/no). */
export function stalenessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.CRBRO_STALENESS ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * The windows in force: the defaults, with whatever CRBRO_SHELF_DAYS overrides.
 * A malformed or non-positive value is ignored for that class, never an error:
 * a typo in an environment variable must not switch the warnings off.
 */
export function shelfWindows(env: NodeJS.ProcessEnv = process.env): ShelfWindows {
  const out: ShelfWindows = { ...DEFAULT_SHELF_DAYS };
  const raw = String(env.CRBRO_SHELF_DAYS ?? '').trim();
  if (!raw) return out;
  for (const part of raw.split(/[,;]/)) {
    const m = /^\s*(volatile|normal|durable)\s*[=:]\s*(\d{1,5})\s*$/i.exec(part);
    if (!m) continue;
    const days = Number(m[2]);
    if (Number.isInteger(days) && days > 0) out[m[1].toLowerCase() as WindowedShelf] = days;
  }
  return out;
}

/** volatile < normal < durable < permanent. */
const ORDER: Record<ShelfLife, number> = { volatile: 0, normal: 1, durable: 2, permanent: 3 };

export function isShelfLife(v: unknown): v is ShelfLife {
  return typeof v === 'string' && (SHELF_LIVES as readonly string[]).includes(v);
}

/**
 * The more volatile of two explicit values (absent loses to any value). The
 * merge rule for team spaces: a needless warning costs one check, a missing
 * one costs a wrong answer.
 */
export function mostVolatile(a: ShelfLife | undefined, b: ShelfLife | undefined): ShelfLife | undefined {
  const va = isShelfLife(a) ? a : undefined;
  const vb = isShelfLife(b) ? b : undefined;
  if (!va) return vb;
  if (!vb) return va;
  return ORDER[va] <= ORDER[vb] ? va : vb;
}

// ─── Content detection ───────────────────────────────────────────
//
// An unmarked fact is classified from its text. Conservative on purpose: every
// rule needs a number, a path/URL shape or a role-and-name pattern next to its
// trigger word. A false positive moves a current fact to possibly_stale and
// costs a check; a false negative leaves a volatile value unflagged, which is
// how every version before this one behaved — not a regression.

export type ShelfReason = 'version' | 'price' | 'port' | 'host' | 'url' | 'path' | 'config' | 'role';

/** Lower-cased, accents folded: "versión" and "VERSION" read alike. Length-preserving for Latin text. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Products whose name followed by a number is a version: "PostgreSQL 14", "Node 22", "Python 3.12". */
const VERSIONED = [
  'node', 'nodejs', 'node.js', 'postgres', 'postgresql', 'mysql', 'mariadb', 'mongodb', 'mongo', 'redis', 'sqlite',
  'python', 'php', 'java', 'jdk', 'ruby', 'golang', 'rust', 'typescript', 'ecmascript',
  'react', 'vue', 'angular', 'next', 'next.js', 'nextjs', 'nuxt', 'svelte', 'django', 'laravel', 'rails', 'symfony',
  'spring', 'kotlin', 'swift', 'dart', 'flutter', 'dotnet', '.net', 'deno', 'bun', 'vite', 'webpack', 'electron',
  'ubuntu', 'debian', 'alpine', 'centos', 'fedora', 'rhel', 'windows', 'macos', 'ios', 'android',
  'docker', 'kubernetes', 'k8s', 'nginx', 'apache', 'elasticsearch', 'wordpress', 'woocommerce', 'drupal',
  'gradle', 'maven', 'npm', 'yarn', 'pnpm', 'terraform', 'ansible', 'openssl', 'tls', 'tailwind', 'bootstrap',
  'gpt', 'claude', 'gemini', 'llama', 'mistral', 'opus', 'sonnet', 'haiku',
];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const VERSIONED_RE = new RegExp(`(?:^|[^a-z0-9.])(?:${VERSIONED.map(escape).join('|')})[\\s-]?v?\\d+(?:\\.\\d+)*(?![\\d.]*\\d)`, 'i');

const RULES: Array<{ reason: ShelfReason; test: (raw: string, folded: string) => boolean }> = [
  {
    reason: 'version',
    test: (_raw, t) =>
      /\bv\d+(?:\.\d+)+\b/.test(t)                                              // v2.3
      || /\b(?:version|release)\s*:?\s*v?\d+(?:\.\d+)*/.test(t)                  // version 3.6, versión 5
      || /(?:^|[^\d.])\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9a-z.]+)?(?![\d.]*\d)/.test(t)  // 2.8.0, 1.4.2-beta (not a dd.mm.yyyy day)
      || VERSIONED_RE.test(t),                                                    // PostgreSQL 14, Node 22
  },
  {
    reason: 'price',
    test: (_raw, t) =>
      /[€$£¥]\s?\d|\d(?:[.,]\d+)?\s?[€$£¥]/.test(t)                                // $49, 29 €
      || /\b\d+(?:[.,]\d+)?\s*(?:euros?|eur|usd|dollars?|dolares|libras|pounds?|gbp|mxn|pesos)\b/.test(t)
      || /\d[^.\n]{0,40}(?:\bal mes\b|\bpor mes\b|\/mes\b|\bper month\b|\ba month\b|\/month\b|\/mo\b|\bal ano\b|\bpor ano\b|\bper year\b|\/year\b|\/yr\b|\bmensuales?\b|\banuales?\b)/.test(t)
      || /\b(?:price|pricing|precio|precios|tarifa|tarifas|cuesta|cuestan|cost|costs|fee|cuota)\b[^.\n]{0,30}\d/.test(t),
  },
  {
    reason: 'port',
    test: (_raw, t) =>
      /\b(?:port|puerto|porta)s?\b[^.\n;]{0,20}?\b\d{2,5}\b/.test(t)               // port 8443, el puerto se movió al 2299
      || /(?:localhost|127\.0\.0\.1|\]|[a-z0-9-]+\.[a-z]{2,})\:\d{2,5}\b/.test(t)  // host:8443
      || /(?:^|[\s(])\:\d{4,5}\b/.test(t),                                          // ":5432" alone (not a time)
  },
  {
    reason: 'url',
    test: (_raw, t) => /\b(?:https?|ftp|ssh|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|wss?):\/\/\S+/.test(t),
  },
  {
    reason: 'host',
    test: (_raw, t) =>
      /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(t)                                       // an IPv4
      || /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|app|es|co|ai|cloud|info|biz|eu|uk|de|fr|it|mx|ar|cl|local|internal|lan|xyz|me|tech|site|online|store)\b/.test(t),
  },
  {
    reason: 'path',
    test: (raw) =>
      /(?:^|[\s"'(`])\/[\w.-]+\/[\w.\/-]+/.test(raw)                               // /etc/nginx/…
      || /(?:^|[\s"'(`])[A-Za-z]:[\\/]/.test(raw)                                  // C:\…
      || /(?:^|[\s"'(`])~[\\/]\S*/.test(raw)                                        // ~/…
      || /(?:^|\s)\.\.?\/[\w.-]+/.test(raw),                                        // ./src, ../lib
  },
  {
    reason: 'config',
    test: (raw, t) =>
      /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\s*=\s*\S+/.test(raw)                            // KEY_NAME=value
      || /(?:^|\s)--[a-z][\w-]*=\S+/.test(raw)                                     // --max-old-space-size=4096
      || /\b[a-z][a-z0-9]*_[a-z0-9_]+\b\s*(?:=|:|de|a|en|to|at|is|es)?\s*\d/.test(t)  // memory_limit de 512M
      || /\b(?:set to|configured (?:to|as|at)|configurad[oa]s? (?:a|en|como)|fijad[oa]s? (?:a|en)|establecid[oa]s? (?:a|en)|timeout|time-out|ttl|rate limit|limit|limite|max|maximo|maximum|minimo|minimum|retries|reintentos|threshold|umbral|batch size|pool size|flag)\b[^.\n]{0,25}?\d/.test(t),
  },
];

/** Role words, as written (first letter either case, rest lower) or as acronyms. */
const ROLE_WORDS = [
  'contact', 'contacto', 'lead', 'manager', 'owner', 'responsable', 'encargado', 'encargada', 'jefe', 'jefa',
  'director', 'directora', 'maintainer', 'mantenedor', 'gerente', 'coordinador', 'coordinadora', 'interlocutor',
  'interlocutora', 'representante', 'administrador', 'administradora', 'referente', 'head', 'boss', 'supervisor',
  'supervisora', 'propietario', 'propietaria', 'titular',
];
const ROLE_ACRONYMS = ['CEO', 'CTO', 'CFO', 'COO', 'CMO', 'CPO', 'PM', 'PO'];
const roleAlt = [
  ...ROLE_WORDS.map(w => `[${w[0].toUpperCase()}${w[0]}]${escape(w.slice(1))}`),
  ...ROLE_ACRONYMS,
].join('|');
const NAME = "[A-ZÁÉÍÓÚÑÜ][\\p{L}'’-]+(?:\\s+[A-ZÁÉÍÓÚÑÜ][\\p{L}'’-]+)?";
/** "<role> … is/es <Name>": "La responsable del soporte es Irene Zubiaurre", "Our contact is Ana". */
const ROLE_THEN_NAME = new RegExp(`\\b(?:${roleAlt})\\b[^.\\n]{0,60}?(?:\\b(?:is|es|será|sera|is now|ahora es)\\b|:)\\s+${NAME}`, 'u');
/**
 * "<Name> is the <role>": "Marta es la jefa de proyecto", "Ana is our CTO".
 * The article is required: "Docker es responsable de aislar…" is not a person.
 */
const NAME_THEN_ROLE = new RegExp(`${NAME}\\s+(?:is|es)\\s+(?:(?:now|ahora)\\s+)?(?:the|el|la|our|nuestr[oa])\\s+(?:(?:new|nuev[oa])\\s+)?(?:${roleAlt})\\b`, 'u');

/**
 * The class an unmarked fact gets from its text: volatile when a rule fires
 * (and which one), normal otherwise.
 */
export function detectShelf(text: string): { shelf: 'volatile' | 'normal'; reason?: ShelfReason } {
  const raw = String(text || '');
  if (!raw.trim()) return { shelf: 'normal' };
  const t = fold(raw);
  for (const r of RULES) {
    if (r.test(raw, t)) return { shelf: 'volatile', reason: r.reason };
  }
  if (ROLE_THEN_NAME.test(raw) || NAME_THEN_ROLE.test(raw)) return { shelf: 'volatile', reason: 'role' };
  return { shelf: 'normal' };
}

/** The class that applies to a fact: its explicit shelf_life, or the one its text implies. */
export function shelfOfFact(f: Pick<Fact, 'text' | 'shelf_life'>): { shelf: ShelfLife; inferred: boolean; reason?: ShelfReason } {
  if (isShelfLife(f.shelf_life)) return { shelf: f.shelf_life, inferred: false };
  const d = detectShelf(f.text);
  return { shelf: d.shelf, inferred: true, ...(d.reason ? { reason: d.reason } : {}) };
}

/**
 * The class of a non-fact entry, by kind alone (not settable). null for what
 * is out of scope (the map, the header).
 */
export function shelfOfKind(kind: string): ShelfLife | null {
  switch (kind) {
    case 'decision':
    case 'pattern':
      return 'durable';
    case 'preference':
    case 'error':
    case 'debt':
      return 'permanent';
    default:
      return null;
  }
}

// ─── Age ─────────────────────────────────────────────────────────

/** What recall, inspect and maintenance need to judge an entry. */
export interface StalenessContext {
  nowMs: number;
  windows: ShelfWindows;
  /** manifest.staleness_since: the first boot of a CRBRO that knows shelf life. Absent → now (full grace). */
  since?: string;
}

export function stalenessContext(since?: string | null, env: NodeJS.ProcessEnv = process.env, nowMs: number = Date.now()): StalenessContext | null {
  if (!stalenessEnabled(env)) return null;
  return { nowMs, windows: shelfWindows(env), ...(since ? { since } : {}) };
}

export interface StaleInfo {
  /** Past its window. */
  stale: boolean;
  /** Whole days since the clock started; never negative. */
  age_days: number;
  /** The day of the last verification, or of the entry when never verified. */
  last_verified: string;
  shelf_life: ShelfLife;
  shelf_inferred: boolean;
  /** Which detector rule chose the class, when it was inferred from the text. */
  shelf_reason?: ShelfReason;
  /** The legacy grace applied: the clock runs from this day, not from last_verified. */
  age_from?: string;
  /** The window in days, null for permanent. */
  window: number | null;
}

const parseMs = (iso: string | undefined): number | null => {
  if (!iso || typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/**
 * How far ahead of this machine's clock a check may be dated and still count:
 * a day, for time zones and ordinary drift. Anything later is a clock that is
 * wrong (a teammate's, or a corrupt `at`), and a check from the future would
 * otherwise win every "latest" merge and keep the line fresh until that day.
 */
export const FUTURE_SLACK_MS = DAY_MS;

/** A verification instant, or undefined when it is malformed or too far in the future to be real. */
export function plausibleCheck(iso: string | undefined, nowMs: number = Date.now()): string | undefined {
  const t = parseMs(iso);
  if (t === null || t > nowMs + FUTURE_SLACK_MS) return undefined;
  return iso;
}

/**
 * A fixed share in [0, 1) for a line, from its text hash (FNV-1a): the same
 * line gets the same share on every machine and every call, so the staggered
 * grace is deterministic and needs nothing stored.
 */
export function spreadOf(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x1_0000_0000;
}

/**
 * Judge one entry. `clock` is verified ?? recorded date; `graceable` says
 * whether the legacy grace may move the clock forward to `ctx.since`.
 * Returns null when there is nothing to judge: no date (a line with no date
 * cannot prove it is old any more than it can prove it is recent).
 */
function judge(
  shelf: ShelfLife,
  inferred: boolean,
  reason: ShelfReason | undefined,
  clockIso: string | undefined,
  graceable: boolean,
  ctx: StalenessContext,
  seed: string,
): StaleInfo | null {
  const t = parseMs(clockIso);
  if (t === null) return null;
  let desde = t;
  let ageFrom: string | undefined;
  const window = shelf === 'permanent' ? null : ctx.windows[shelf];
  if (graceable) {
    // No stamp yet (a recall before the first boot of this version): the
    // grace runs from now, so an old brain is never flagged before it is stamped.
    const s = ctx.since ? parseMs(ctx.since) : ctx.nowMs;
    if (s !== null && s > t) {
      // Staggered, not one shared start: if every old line ran from the
      // stamp, they would all cross their window on the same day and an old
      // brain would go from no warnings to all of them at once. Each line's
      // clock starts up to half a window before the stamp, by a fixed share
      // drawn from a hash of its text, and never before its real date. On the
      // stamp day nothing is past its window (at most half of it has
      // elapsed), and an old brain's lines come due evenly over the second
      // half of the first window instead of on one day.
      const half = window === null ? 0 : (window * DAY_MS) / 2;
      const atras = Math.min(s - t, half * spreadOf(seed));
      desde = s - atras;
      ageFrom = new Date(desde).toISOString().slice(0, 10);
    }
  }
  const age = Math.max(0, Math.floor((ctx.nowMs - desde) / DAY_MS));
  return {
    stale: window !== null && age > window,
    age_days: age,
    last_verified: new Date(t).toISOString().slice(0, 10),
    shelf_life: shelf,
    shelf_inferred: inferred,
    ...(reason ? { shelf_reason: reason } : {}),
    ...(ageFrom ? { age_from: ageFrom } : {}),
    window,
  };
}

/** A fact's standing. Retired facts are not judged (they never surface). */
export function factStaleness(f: Fact, ctx: StalenessContext): StaleInfo | null {
  if (!f || (f.status && f.status !== 'active')) return null;
  const s = shelfOfFact(f);
  // A check dated in the future is treated as no check: the clock runs from
  // the recorded date, never from a day that has not come.
  const verified = plausibleCheck(f.verified, ctx.nowMs);
  const clock = verified ?? f.added;
  // Legacy grace: never re-checked, nobody chose its class, not volatile.
  // Volatile facts get none: a port saved months ago deserves the warning on
  // the first recall that serves it — that is the case this exists for.
  const graceable = !verified && s.inferred && s.shelf !== 'volatile';
  return judge(s.shelf, s.inferred, s.reason, clock, graceable, ctx, entryId(f.text));
}

/**
 * A decision, pattern, preference, error or debt, by kind and text. Its clock
 * is entry_verified, else its recorded date (a decision's `date`, the
 * entry_dates sidecar for the rest). Permanent kinds come back with
 * stale:false so callers can still show their age if they want to.
 */
export function entryStaleness(neuron: Neuron, kind: string, text: string, ctx: StalenessContext): StaleInfo | null {
  const shelf = shelfOfKind(kind);
  if (!shelf || !text) return null;
  let base = text;
  let fecha: string | undefined;
  if (kind === 'decision') {
    // A decision chunk in the index is "text — rationale"; the entry is the text.
    const d = (neuron.decisions || []).find(x => x.text === text || (x.rationale ? `${x.text} — ${x.rationale}` : x.text) === text);
    if (!d) return null;
    base = d.text;
    fecha = d.date;
  } else {
    fecha = neuron.entry_dates?.[entryId(base)];
  }
  const id = entryId(base);
  const verified = plausibleCheck(neuron.entry_verified?.[id], ctx.nowMs);
  return judge(shelf, true, undefined, verified ?? fecha, !verified && shelf !== 'permanent', ctx, id);
}

/**
 * The latest of two ISO instants. Absent, unparseable or implausibly future
 * (past now + FUTURE_SLACK_MS) loses: a check from a clock that is ahead must
 * not win every later merge and pin the line as fresh until that day.
 */
export function latestOf(a: string | undefined, b: string | undefined, nowMs: number = Date.now()): string | undefined {
  const ta = parseMs(plausibleCheck(a, nowMs)), tb = parseMs(plausibleCheck(b, nowMs));
  if (ta === null) return tb === null ? undefined : b;
  if (tb === null) return a;
  return tb > ta ? b : a;
}
