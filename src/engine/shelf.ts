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
//   permanent — history: preferences, errors, debts, a fact marked so, and
//               (2.9.1) a dated record of something done or a line the
//               miner imported                    (never)
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

/**
 * Why an unmarked fact got its class. The first eight make it volatile;
 * `history` (a dated record of something done) and `miner` (imported by the
 * miner) make it permanent (2.9.1).
 */
export type ShelfReason = 'version' | 'price' | 'port' | 'host' | 'url' | 'path' | 'config' | 'role' | 'history' | 'miner';

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

// ─── History: a dated record of something done (2.9.1) ───────────
//
// "FASE 2 completada (ago 2026)", "2026-08-11: VERIFICADO que …", "RECHAZO
// de la tienda v3.4.0 (9 jul 2026)", "Deployed v2.3.1 on 2026-06-18":
// a line that says what was done and when does not go stale — it tells what
// happened, and it carries its own date, so whoever reads it sees how old it
// is. Before 2.9.1 the version, URL or path inside such a record made the
// whole line volatile, and on a real personal brain records were a large
// share of what the detector flagged (docs/design/staleness.md §15).
//
// The rule, all on the line's HEAD (its text up to the first sentence end —
// ". ", "! ", "? " — or line break; details after it are not judged):
//   1. the head names a date: 2026-06-18, 18/06/2026, 18-jun-2026, 18 de
//      junio (de 2026), jun 2026, June 18, 2026;
//   2. the head has a word of finished action: a Spanish participle
//      (completado, implementada, resueltos, desplegado, publicado, verificado,
//      corregido, migrado, creado, añadido, rechazado, medido…), an
//      unambiguous Spanish preterite (desplegó, migró, corrigió, resolvió, or
//      any of them after "se": "se publicó"), an English past form (fixed,
//      deployed, released, completed, verified, migrated, checked…) or an
//      event noun (fix, hotfix, rechazo, incidente, outage, release,
//      ejecución…);
//   3. and none of these turns it back into a statement of state:
//      - a date that opens a period: "desde el 18-sep", "since", "a partir
//        de", "as of", "from", "hasta", "until", "a 4-oct", "al 4-oct";
//      - a word of the future or of a deadline: will, planned, previsto,
//        programado, pendiente, caduca, expires, vence, renews, next,
//        próximo, "para el <date>", "by <date>", "antes del <date>" ("tarea
//        programada" and "scheduled task" name a kind of job and do not count);
//      - a word of the present: actualmente, currently, current, actual,
//        ahora, now, todavía, still, vigente, último, last, latest;
//      - a verb of state BEFORE the first finished-action word: "la API
//        corre en el puerto 8443, desplegada el 2026-06-18" is a port that
//        also says when it went up, so it stays volatile;
//   4. and, when the head carries a changeable value (a volatile rule fires
//      on it with its dates blanked), none of these says the value holds:
//      - a verb of state anywhere in it, or pasa a, queda, sigue, devuelve,
//        responde, abierto, becomes, returns ("Fix (4-oct-2026): el webhook
//        apunta a https://…", "La release 2.3 usa el puerto 8443 (jun 2026)");
//      - a check — verificado, comprobado, confirmado, probado, medido,
//        detectado, verified, checked… — with the value before it ("Puerto
//        9443 verificado el 2026-09-18", "Plan: $499/año (confirmado …)"): a
//        dated check of a value is that value, with the day it was seen;
//      - a move to a place: migrado, desplegado, instalado, migrated,
//        deployed… followed within four words by a/al/en/to/into/on/at and a
//        port, host, URL or path ("se migró el panel al puerto 9443",
//        "Deployed to https://app.example.com on 2026-06-18");
//      - a schedule: a cycle word with a time of day ("ejecución diaria 03:00
//        en /var/backups") or cada/every with a unit ("cada lunes");
//      - a word that also describes a state — cerrado, aprobado, completo,
//        medida, closed, approved, complete — when it is the only
//        finished-action word ("Presupuesto aprobado (…): 1.200 € al mes").
//   Quoted titles and asides in parentheses are not read for the verbs.
// Words that introduce a new current value without telling an event —
// actualizado, cambiado, configurado, updated, changed, set, renovado — are
// deliberately not finished-action words. The adjective "completa" counts
// fully only after a kind of work ("FASE 4 completa"). A line with no date
// is never history, however past its verbs are: it cannot show its age.
//
// Limits, said once: the head decides, so "Migrado a Hetzner (3-oct-2026).
// El host es 10.0.0.5." is history whole; the line's own date is what tells
// the reader how old that host is. Only Spanish and English. A record without
// a date ("Publicado el artículo en https://…") is not history. A version is
// not a place: "Instalado Node 20.11.0 en el servidor (3-oct-2026)" and
// "Migrado a PostgreSQL 16 el 3-oct-2026" are records of an upgrade.

/** Month names and the abbreviations people write, es/en, longest first. */
const MONTH = '(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|'
  + 'january|february|march|april|june|july|august|september|october|november|december|'
  + 'ene|feb|mar|abr|may|jun|jul|ago|sept|sep|oct|nov|dic|jan|apr|aug|dec)\\.?(?![a-z])';
/** A calendar date as people write it, on folded text. Year optional only after a day and a month name. */
const DATE = '(?:'
  // A numeric date is not glued to a word, a version or a path: in "/api/v1/12/24" there is no day.
  + '(?<![\\w./-])20\\d{2}[-/]\\d{1,2}[-/]\\d{1,2}(?![\\d])'                     // 2026-06-18
  + '|(?<![\\w./-])\\d{1,2}/\\d{1,2}/(?:20)?\\d{2}(?![\\d./])'                    // 18/06/2026
  + '|(?<![\\w./-])\\d{1,2}-\\d{1,2}-(?:20)?\\d{2}(?![\\d./-])'                   // 18-06-2026
  + '|(?<![\\w./-])\\d{1,2}\\.\\d{1,2}\\.20\\d{2}(?![\\d.])'                       // 18.06.2026 (not a version)
  // Day + month. A bare "may" followed by another word is the English modal ("Node 18 may be removed"), not May.
  + `|(?<!\\d)\\d{1,2}º?(?:\\s+de\\s+|[\\s-]+)(?!may\\s+(?!de\\s+20)[a-z])${MONTH}(?:(?:\\s+de\\s+|,?\\s+|-)20\\d{2}(?!\\d))?`  // 18-jun(-2026), 18 de junio de 2026
  + `|(?<![a-z])${MONTH}(?:\\s+de\\s+|\\s+|-)20\\d{2}(?!\\d)`                     // jun 2026, junio de 2026
  + `|(?<![a-z])${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+20\\d{2}(?!\\d)`         // June 18, 2026
  + ')';
const DATE_RE = new RegExp(DATE);
const DATE_ALL = new RegExp(DATE, 'g');

/** Not part of a path, a branch name or an identifier: "fix-newsletter/", "hotfix/login" are not events. */
const W0 = '(?<![a-z0-9_/.\\-])';
const W1 = '(?![a-z0-9_/\\-])';
/** Kinds of work that can be "complete": "FASE 4 COMPLETA", "Auditoría SEO completa". Not a list or a configuration. */
const WORK = '(?:fase|fases|etapa|auditoria|migracion|tarea|tareas|revision|repaso|implementacion|instalacion|ejecucion'
  + '|integracion|prueba|pruebas|limpieza|sesion|sprint|refactor|refactorizacion|traduccion|importacion|indexacion|copia|backup)';
const DONE = new RegExp(W0 + '(?:'
  // Spanish participles, any gender and number. Cerrado and aprobado are in STATIVE below: they also
  // describe a state ("puerto 22 cerrado", "presupuesto aprobado: 1.200 €/mes").
  + '(?:completad|implementad|resuelt|desplegad|publicad|verificad|comprobad|confirmad|corregid|migrad|cread'
  + '|anadid|rechazad|denegad|arreglad|terminad|finalizad|lanzad|instalad|eliminad|borrad|enviad|entregad'
  + '|auditad|integrad|solucionad|probad|testead|validad|detectad|reparad|restaurad|revertid|fusionad|renombrad|retirad'
  + '|descartad|construid|realizad|ejecutad|aplicad|cancelad|abortad|reescrit|rehech)(?:o|a|os|as)'
  // The adjective "completa" only after a kind of work: "Lista completa de precios" is not an event.
  + `|(?<=(?:^|[^a-z])${WORK}(?:\\s+\\S+){0,3}\\s+)complet(?:o|a|os|as)`
  // "medido"; "medida" only when it is not the noun ("a medida", "medida de seguridad").
  + '|medid(?:o|os)|(?<!(?:^|[^a-z])(?:a|la|las|una|unas|de|del|sus?) )medidas?(?! de(?![a-z]))'
  // Spanish preterites that are not also a common noun, adjective or present tense.
  + '|desplego|desplegue|migro|migre|corrigio|corregi|resolvio|resolvi|rechace|arregle|verifique|verifico|finalizo'
  + '|finalice|elimino|elimine|aprobo|publique|implemente|implemento|hizo|hice|hicimos'
  // "se" + preterite is unambiguous even where the bare form is not ("se publicó" vs "público").
  + '|se (?:publico|creo|anadio|lanzo|instalo|elimino|borro|desplego|corrigio|resolvio|migro|cerro|aprobo|envio|entrego'
  + '|termino|completo|implemento|aplico|ejecuto|cancelo|midio|arreglo|reparo|verifico|comprobo|rechazo)'
  // Event nouns.
  + '|fix|hotfix|bugfix|rechazo|incidente|incidencia|incident|outage|caida|post-?mortem|release|lanzamiento|ejecucion'
  // English past forms.
  + '|fixed|deployed|released|completed|implemented|resolved|published|verified|confirmed|migrated|created|added'
  + '|rejected|shipped|merged|launched|installed|removed|deleted|done|finished|sent|audited|tested'
  + '|validated|detected|repaired|restored|reverted|solved|delivered|submitted|renamed|built|rolled back|refactored|applied'
  + '|checked|measured|executed|uploaded|posted|cancell?ed|aborted'
  + ')' + W1);
/**
 * Words that tell an event or describe a state: "FASE 0 APROBADA el 2-sep",
 * "Tanda CERRADA el 21-sep", "DIAGNÓSTICO COMPLETO (21-08-2026)" are records,
 * "Puerto 22 cerrado (…): SSH en el 65002", "Presupuesto aprobado (…): 1.200 €
 * al mes", "Lista completa de precios (…)" are states. They count as a
 * finished action only in a head that carries no changeable value.
 */
const STATIVE = new RegExp(W0 + '(?:(?:cerrad|aprobad|complet)(?:o|a|os|as)|(?<!(?:^|[^a-z])(?:a|la|las|una|unas|de|del|sus?) )medidas?|closed|approved|complete)' + W1);
/** A date that opens a period, or a moment that does: the line states what holds from then on. */
const OPENS_PERIOD = new RegExp(
  `(?<![a-z])(?:desde|since|a partir del?|as of|as from|from|effective(?: from)?|con efecto(?: desde)?|a fecha de|hasta|until|till|a|al)\\s+`
  + `(?:(?:el|la|los|the|dia|day)\\s+)*(?:${DATE}|entonces|then|hoy|today|ahora|now|ese dia|that day)`);
/** The future, a deadline or a renewal: something still to happen is not a record. */
const FUTURE = new RegExp(
  // "Tarea programada" and "scheduled task" name a kind of job, not a future: they stay out.
  '(?<![a-z])(?:will|shall|going to|planned|planificad[oa]s?|previst[oa]s?|(?<!(?:tarea|rutina)s? )programad[oa]s?'
  + '|scheduled(?! (?:tasks?|jobs?|routines?))|pendientes?|pending'
  + '|por hacer|to-do|deadline|fecha limite|plazo|vencen?|vencimiento|caducan?|caducidad|expiran?|expires?|expiry'
  + '|renuevan?|renews?|renewal|next|proxim[oa]s?|siguientes?)(?![a-z])'
  + `|(?<![a-z])(?:para el|para|by|antes del?|before|no later than)\\s+(?:(?:el|la|the)\\s+)?${DATE}`);
/** The present: the line says what holds now, whatever else it records. */
const PRESENT = /(?<![a-z])(?:actualmente|currently|current|actual|actuales|ahora|now|todavia|aun|still|hoy en dia|a dia de hoy|vigente|en vigor|in force|ultim[oa]s?|last|latest)(?![a-z])/;
/**
 * Verbs that state how something is. Before the first finished-action word
 * they make the line a statement of state. Not inside a domain or a path:
 * the "es" of "garza.es" is not a verb.
 */
const STATE_WORDS = 'es|son|is|are|corre|corren|runs?|usa|usan|uses?|tiene|tienen|cuesta|cuestan|costs?|vale|valen|apunta|apuntan'
  + '|points?|escucha|escuchan|listens?|requiere|requieren|requires?|sirve|sirven|serves?|vive|viven|lives?|funciona|funcionan'
  + '|works?|contiene|contienen|contains?|ocupa|ocupan';
const STATE_VERB = new RegExp(`(?<![a-z0-9_./-])(?:${STATE_WORDS}|esta|estan)(?![a-z])`);
/**
 * The same verbs and a few more that say what holds (pasa a, queda, sigue,
 * devuelve, responde, abierto, becomes, returns…), looked for anywhere in a
 * head that carries a changeable value: "Desplegado el 18-jun-2026: la API
 * corre en el puerto 8443" is a port, whatever came first. "Esta" counts only
 * as the verb ("está en", "está caído"), not as "this" ("esta web").
 */
const STATE_AFTER = new RegExp(
  '(?<![a-z0-9_./-])(?:'
  + STATE_WORDS
  + '|estan?(?= (?:en|a|al|ahora|caid|activ|disponible|abiert|operativ|online|offline|rot|vaci|llen|list|apuntando|corriendo|usando|sirviendo))'
  + '|pasan? a|quedan?|siguen?|devuelven?|returns?|responden?|responds?|becomes?|abiert[oa]s?|open'
  + ')(?![a-z])');
/** A check of something: dated, it tells what held that day, and what held is the value. */
const CHECK = /^(?:verificad|comprobad|confirmad|probad|testead|validad|detectad|medid|verifique|verifico|se verifico|se comprobo|se midio|verified|confirmed|checked|tested|validated|measured|detected)/;
/** A move to a place: "migrado al puerto 9443", "deployed to https://…" says where the thing lives now. */
const MOVE = /^(?:migrad|desplegad|instalad|trasladad|movid|migro|migre|desplego|desplegue|se migro|se desplego|se instalo|migrated|deployed|installed|moved)/;
/** What follows a move, up to four words later, when it names the destination. */
const TO_PLACE = /^[^\s]*(?:\s+[^\s]+){0,4}?\s+(?:a|al|en|hacia|to|into|on|at)\s+(.*)$/;
/**
 * Something done on a cycle is a schedule, not an event: "ejecución diaria
 * 03:00 en /var/backups". A cycle word alone is not enough — "Ejecución
 * diaria del 31-ago-2026: publicados…" is one run of a daily job, a record —
 * so it takes a time of day right after it, or cada/every with a unit.
 */
const RECURRING = new RegExp('(?<![a-z])(?:'
  + '(?:diari[oa]s?|diariamente|semanal(?:es|mente)?|mensual(?:es|mente)?|daily|nightly|weekly|monthly|hourly)'
  + '(?:\\s+(?:a las|at))?\\s+\\d{1,2}[:h]\\d{2}'
  + '|(?:cada|every)\\s+(?:\\d+\\s+)?(?:dia|dias|hora|horas|semana|semanas|mes|meses|minutos?|lunes|martes|miercoles|jueves|viernes|sabado|domingo'
  + '|day|days|hour|hours|week|weeks|month|months|minutes?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|night|noche)'
  + ')(?![a-z0-9])');

/** Month abbreviations a period may follow without ending the sentence: "jun. 2026", "Sept. 18". */
const MONTH_ABBR_DOT = /(?<![a-z])(?:ene|feb|mar|abr|may|jun|jul|ago|sept|sep|oct|nov|dic|jan|apr|aug|dec)$/;

/** The head of a line: up to the first sentence end or line break. */
function headOf(folded: string): string {
  const re = /[.!?](?=\s|$)|\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(folded))) {
    if (m[0] === '.' && MONTH_ABBR_DOT.test(folded.slice(0, m.index))) continue;
    return folded.slice(0, m.index);
  }
  return folded;
}

/**
 * Which volatile rule fires on a piece of a line, with its dates blanked out
 * (a date is not a value). `raw` and `folded` are the same piece; folding is
 * length-preserving for Latin text, so a date found in one is blanked in both.
 */
function valueIn(raw: string, folded: string): ShelfReason | undefined {
  let r0 = raw, f0 = folded;
  if (r0.length === f0.length) {
    for (const m of folded.matchAll(DATE_ALL)) {
      const a = m.index ?? 0, b = a + m[0].length, gap = ' '.repeat(b - a);
      r0 = r0.slice(0, a) + gap + r0.slice(b);
      f0 = f0.slice(0, a) + gap + f0.slice(b);
    }
  } else {
    r0 = f0 = folded.replace(DATE_ALL, ' ');
  }
  for (const r of RULES) if (r.test(r0, f0)) return r.reason;
  return undefined;
}

/**
 * True when the text reads as a dated record of something done (see the
 * rule above). Exported for the tests and the design doc's examples.
 */
export function isDatedRecord(text: string): boolean {
  return recordVerdict(text).record;
}

/** Quoted titles say nothing about state: «… que siguen trabajando …» is a headline. Blanked, length kept. */
const QUOTED = /«[^»\n]*»|"[^"\n]*"|“[^”\n]*”/g;
/** Nor does an aside in parentheses: "publicado en npm (no es repo git)" is a record with a remark. */
const ASIDE = /\([^()\n]*\)/g;
const blankAsides = (s: string) => s.replace(QUOTED, m => ' '.repeat(m.length)).replace(ASIDE, m => ' '.repeat(m.length));

/**
 * The same decision with the rule that made it, for the tests and for
 * diagnosing a real brain: 'record', or the first rule that said no.
 */
export function recordVerdict(text: string): { record: boolean; why: string } {
  const no = (why: string) => ({ record: false, why });
  const raw = String(text || '');
  if (!raw.trim()) return no('empty');
  const folded = fold(raw);
  const head = headOf(folded);
  if (!DATE_RE.test(head)) return no('no-date');
  const strict = DONE.exec(head);
  const done = strict ?? STATIVE.exec(head);
  if (!done) return no('no-done');
  if (OPENS_PERIOD.test(head)) return no('opens-period');
  if (FUTURE.test(head)) return no('future');
  if (PRESENT.test(head)) return no('present');
  if (STATE_VERB.test(head.slice(0, done.index))) return no('state-before');
  // Rule 4: only a head that carries a changeable value can state it as current.
  const rawHead = raw.length === folded.length ? raw.slice(0, head.length) : head;
  if (!valueIn(rawHead, head)) return { record: true, why: 'record' };
  if (!strict) return no(`stative-with-value:${done[0]}`);
  const plain = blankAsides(head);
  const after = STATE_AFTER.exec(plain);
  if (after) return no(`state-after:${after[0]}`);
  if (RECURRING.test(plain)) return no('recurring');
  const word = done[0];
  if (CHECK.test(word)) {
    const before = valueIn(rawHead.slice(0, done.index), head.slice(0, done.index));
    // A bare domain before a check is usually the site being checked, not the value.
    if (before && before !== 'host') return no('check-of-value');
  }
  if (MOVE.test(word)) {
    const end = done.index + word.length;
    const to = TO_PLACE.exec(head.slice(end));
    if (to) {
      const start = head.length - to[1].length;
      // The destination is the few words after the preposition, not the rest of the line.
      const object = /^\S+(?:\s+\S+){0,2}/.exec(to[1])?.[0] ?? '';
      const where = valueIn(rawHead.slice(start, start + object.length), object);
      if (where === 'port' || where === 'host' || where === 'url' || where === 'path') return no('move-to-place');
    }
  }
  return { record: true, why: 'record' };
}

/**
 * The class an unmarked fact gets from its text: permanent when it is a dated
 * record of something done (2.9.1), else volatile when a rule fires (and
 * which one), normal otherwise.
 */
export function detectShelf(text: string): { shelf: 'volatile' | 'normal' | 'permanent'; reason?: ShelfReason } {
  const raw = String(text || '');
  if (!raw.trim()) return { shelf: 'normal' };
  if (isDatedRecord(raw)) return { shelf: 'permanent', reason: 'history' };
  const t = fold(raw);
  for (const r of RULES) {
    if (r.test(raw, t)) return { shelf: 'volatile', reason: r.reason };
  }
  if (ROLE_THEN_NAME.test(raw) || NAME_THEN_ROLE.test(raw)) return { shelf: 'volatile', reason: 'role' };
  return { shelf: 'normal' };
}

/**
 * The class that applies to a fact: its explicit shelf_life; else permanent
 * when the miner imported it (2.9.1: an imported note is a copy of something
 * written elsewhere, at some other time, and was never a claim this memory
 * made about the present — warning on it is noise); else the one its text
 * implies.
 *
 * Once a session has said the same line too, it is no longer only an
 * imported note: the duplicate branch of learn keeps `source: "miner"` but
 * sets `verified` or adds a confirmation, and from then on the line is judged
 * by its text like any other claim about the present.
 */
export function shelfOfFact(
  f: Pick<Fact, 'text' | 'shelf_life'> & { source?: string; verified?: string; confirmations?: number },
): { shelf: ShelfLife; inferred: boolean; reason?: ShelfReason } {
  if (isShelfLife(f.shelf_life)) return { shelf: f.shelf_life, inferred: false };
  if (f.source === 'miner' && !f.verified && (f.confirmations ?? 1) <= 1) return { shelf: 'permanent', inferred: true, reason: 'miner' };
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
  /**
   * The brain existed before a CRBRO that knows shelf life first booted it
   * (2.9.1). Then the facts the detector infers volatile get the staggered
   * grace too, not only the rest: a brain written for months before 2.9 has
   * hundreds of them, and flagging them all on upgrade day is the flood the
   * grace exists to prevent. A brain created by 2.9 or later is not legacy,
   * so a volatile line written there before the stamp still warns at once.
   */
  legacy?: boolean;
}

/**
 * How long after `created` a stamp may come and still belong to a brain born
 * stamped: initialize() writes both in the same call, an upgrade writes the
 * stamp at the first boot of a new version, days or months later.
 */
const LEGACY_MARGIN_MS = 60_000;

/**
 * Whether a brain predates shelf life, from its manifest: not stamped yet, a
 * creation date that cannot be read, or a stamp later than its creation by
 * more than LEGACY_MARGIN_MS.
 */
export function isLegacyBrain(created: string | null | undefined, since: string | null | undefined): boolean {
  const s = parseMs(since ?? undefined);
  if (s === null) return true;
  const c = parseMs(created ?? undefined);
  if (c === null) return true;
  return s - c > LEGACY_MARGIN_MS;
}

/**
 * `created` is the manifest's: pass it (see stalenessContextOf) and the
 * context knows whether the brain is legacy. Left out, it is not legacy —
 * the 2.9.0 behaviour, where a volatile fact never got the grace.
 */
export function stalenessContext(since?: string | null, env: NodeJS.ProcessEnv = process.env, nowMs: number = Date.now(), created?: string | null): StalenessContext | null {
  if (!stalenessEnabled(env)) return null;
  const legacy = created !== undefined && isLegacyBrain(created, since);
  return { nowMs, windows: shelfWindows(env), ...(since ? { since } : {}), ...(legacy ? { legacy: true } : {}) };
}

/** The context for a brain, from its manifest (or none, when it could not be read: no legacy, full grace). */
export function stalenessContextOf(
  manifest: { staleness_since?: string | null; created?: string | null } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): StalenessContext | null {
  if (!manifest) return stalenessContext(undefined, env, nowMs);
  return stalenessContext(manifest.staleness_since, env, nowMs, manifest.created ?? null);
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
  // Legacy grace: never re-checked, nobody chose its class. A volatile fact
  // gets it only in a brain that predates shelf life (2.9.1): there the
  // detector's volatile lines are hundreds, written before anyone could mark
  // them, and flagging them all on upgrade day buries the few that matter. A
  // fact marked volatile by hand gets none (not inferred), and in a brain
  // born with shelf life neither does an inferred one: a port saved months
  // ago deserves the warning on the first recall that serves it.
  const graceable = !verified && s.inferred && (s.shelf !== 'volatile' || ctx.legacy === true);
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
