// ─── CRBRO Cortex Engine ─────────────────────────────────────────
// Neuron CRUD — create, read, update, list neurons

import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { readJSON, updateJSON, deleteJSON, listJSONFiles, fileExists, now, CorruptJSONError } from '../utils/fs.js';
import { withLock } from '../utils/lock.js';
import { neuronId, inferNeuronType, slugCandidates, typeOfIdShape } from '../utils/ids.js';
import { writeQuarantine, readQuarantine, listQuarantine, entriesAsNeuron, isEntriesCopy, type QuarantineEntries } from './quarantine.js';
import { listBackups, resolveBackupDir } from './backup.js';
import { readHeatState } from './heat.js';
import { factId } from '../utils/hash.js';
import { entryId, normalizeText, type Op } from '../sync/ops.js';
import { applyOps, type MergeReport } from '../sync/materialize.js';
import { redact, secretKinds } from './secrets.js';
import { shelfOfFact, mostVolatile, isShelfLife, type ShelfReason } from './shelf.js';
import { sanitizeReference, sanitizeTemporal, makeVerification, mergeCheck, mergeFactEvidence, mergeEntryEvidence, type VerificationInput } from './evidence.js';
import type { Brain } from './brain.js';
import type { Neuron, NeuronType, Fact, Decision, FactStatus, EntryStatus, EntryRetirement, ShelfLife, SourceReference, Verification } from '../types/index.js';

const TYPE_PREFIX_RE = /^(project_|tech_|lang_|person_|domain_|process_|protocol_)/;

/**
 * Similarity above which a new fact is flagged as a near-duplicate of one
 * already in the neuron. Warn-only, never merge: blind similarity is how
 * "sprint_2" and "sprint_3" become one thing. Below 60 characters the
 * bigram signal is noise, so short facts are left to the exact-dup check.
 */
const NEAR_DUP_THRESHOLD = 0.8;
const NEAR_DUP_MIN_LENGTH = 60;

/**
 * A neuron file that exists and cannot be parsed. Readers skip it and list it
 * (Cortex.unreadable); writers refuse with this error, which names the file
 * and where a good copy may be.
 */
export class UnreadableNeuronError extends Error {
  constructor(public readonly neuronId: string, public readonly path: string, public readonly recovery: string, reason: string) {
    super(`Neuron "${neuronId}" cannot be read (${reason}). Nothing was written. ${recovery}`);
    this.name = 'UnreadableNeuronError';
  }
}

export interface UnreadableNeuron {
  id: string;
  path: string;
  error: string;
  recovery: string;
}

/** How learn resolved a topic to a neuron (2.11). */
export type ResolvedBy = 'neuron_id' | 'id' | 'name' | 'variant' | 'created';

/**
 * The same identifier written two ways: underscores dropped and each long
 * word's plural folded ("widget_catalogs" ~ "widget catalog", "octo_chat" ~
 * "octochat"). Nothing else. The bigram similarity this replaces merged
 * "sprint_a" into "sprint_b" (0.857 ≥ 0.85) and any two long names one letter
 * apart: a letter that differs is usually what tells two things apart.
 */
function nameVariantKey(slug: string): string {
  return slug.split('_').filter(Boolean).map(t => (t.length > 4 && !/\d/.test(t) ? t.replace(/(es|s)$/, '') : t)).join('');
}

/**
 * `witnessed`: "<neuron>|<fact id>" of every fact this session stored or
 * confirmed. A session is one witness: storing the same line again in the
 * same session (a retry, the post-compaction re-save) does not count twice.
 * Not cleared by consolidate, which ends a chapter, not the conversation.
 */
export interface SessionTally { facts: number; decisions: number; topics: Set<string>; witnessed?: Set<string>; verifiedEmitted?: Set<string> }
export const newTally = (): SessionTally => ({ facts: 0, decisions: 0, topics: new Set<string>(), witnessed: new Set<string>() });
/**
 * The connection a request belongs to, carried through every await. Empty
 * outside the daemon. `resumed`: this backend took over a conversation that
 * was already running (its daemon died), so the tally starts at zero although
 * the conversation did not — consolidate must not present that zero as the truth.
 */
export const sessionScope = new AsyncLocalStorage<{ tally: SessionTally; resumed?: boolean }>();

/**
 * Dice coefficient over character bigrams. Cheap, order-insensitive enough
 * for "Widget Catalog" vs "widget_catalog", and — unlike substring containment —
 * it does not consider a 60-character walkthrough id a match for "SEO".
 */
function bigramsOf(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

/** Dice of a precomputed bigram map (text of length aLen) against b. */
function diceFrom(A: Map<string, number>, aLen: number, b: string): number {
  if (aLen < 2 || b.length < 2) return 0;
  const B = bigramsOf(b);
  let shared = 0;
  for (const [g, countA] of A) {
    const countB = B.get(g);
    if (countB) shared += Math.min(countA, countB);
  }
  return (2 * shared) / (aLen - 1 + b.length - 1);
}

/**
 * Do two slugs carry the same numbers, in the same order?
 *
 * Bigram similarity is blind to a single differing digit: "sprint_2" and
 * "sprint_3" score 0.857, and "old_topic_1" against "old_topic_11" scores
 * 0.952 — both above any sane threshold. Numbers in a topic name are almost
 * always what distinguishes it, so a near-miss that disagrees on them is not
 * a near-miss at all.
 */
function sameNumbers(a: string, b: string): boolean {
  const na = a.match(/\d+/g) || [];
  const nb = b.match(/\d+/g) || [];
  return na.length === nb.length && na.every((v, i) => v === nb[i]);
}

/**
 * Near-duplicates of `content` among `candidates`, best first: Dice ≥ 0.8 on
 * lower-cased text, both sides at least NEAR_DUP_MIN_LENGTH characters. The
 * one rule behind learn's near_duplicates warning (inside one neuron) and
 * consolidate's promotion_candidates (across project neurons), so the two
 * cannot disagree on what "almost the same line" means.
 */
export function nearDuplicatesAmong(
  content: string,
  candidates: Array<{ id: string; text: string }>
): Array<{ id: string; similarity: number; text: string }> {
  if (content.length < NEAR_DUP_MIN_LENGTH) return [];
  const nuevo = content.toLowerCase();
  // The new text's bigrams once, not once per candidate (2.11): on a 700-fact
  // neuron that was the same map rebuilt hundreds of times per learn.
  const bigramasNuevo = bigramsOf(nuevo);
  const out: Array<{ id: string; similarity: number; text: string }> = [];
  for (const c of candidates) {
    if (!c.text || c.text.length < NEAR_DUP_MIN_LENGTH) continue;
    // Dice over bigrams cannot reach the threshold when one side is much
    // longer: 2·min/(a+b) bounds it. A free filter before the real count.
    const a = nuevo.length, b = c.text.length;
    if ((2 * Math.min(a, b)) / (a + b) < NEAR_DUP_THRESHOLD) continue;
    const otro = c.text.toLowerCase();
    const score = nuevo === otro ? 1 : diceFrom(bigramasNuevo, nuevo.length, otro);
    if (score >= NEAR_DUP_THRESHOLD) out.push({ id: c.id, similarity: Math.round(score * 100) / 100, text: c.text });
  }
  out.sort((x, y) => y.similarity - x.similarity);
  return out;
}

/** Lesson kinds that can be promoted: what was learned, not what was decided or preferred. */
export type LessonKind = 'fact' | 'pattern' | 'error';

export interface PromotionCandidate {
  kind: LessonKind;
  /** The telling to promote: the most confirmed copy, then the longest. */
  text: string;
  /** Project neurons that hold it, the one written this session first. */
  neurons: string[];
  /** The entry id of the copy in each of `neurons`, same order. */
  entry_ids: string[];
  /** Lowest similarity in the group: 1 when every copy is the same text. */
  similarity: number;
  /** Sum of the copies' confirmations (each copy counts at least 1). */
  confirmations: number;
}

/** Most promotion candidates consolidate reports. More is a backlog, not a nudge. */
export const MAX_PROMOTION_CANDIDATES = 5;
/** Lessons of this session's project neurons compared against the rest. Bounds the cost of a sprawling session. */
const MAX_PROMOTION_SEEDS = 300;
/** Share of a lesson's distinctive words a copy must also hold before the bigram test runs. */
const PROMOTION_MIN_OVERLAP = 0.6;
/**
 * A word found in more lessons than this says nothing about which lesson is
 * a copy of which ("para", "proyecto"): it is not counted. The larger of an
 * absolute floor and a share of the brain, so small brains keep every word.
 */
const PROMOTION_COMMON_WORD = { min: 200, share: 0.05 };

/** Lower-cased, accents folded, whitespace collapsed: the "same text" test. */
function normLesson(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function lessonWords(norm: string): string[] {
  return [...new Set(norm.split(/[^a-z0-9_]+/).filter(w => w.length >= 3 && !/^\d+$/.test(w)))];
}

function lessonNumbers(norm: string): string[] {
  return [...new Set(norm.match(/\d+/g) || [])];
}

/**
 * The same lesson living in two or more project neurons: the mark of
 * something that is not about one project at all and belongs in a tech_ or
 * process_ neuron where every project finds it.
 *
 * Generalises findNearDuplicates (one neuron) to many without making it
 * quadratic: only the lessons of `seedIds` — the project neurons this session
 * touched — are compared, and each only against the lessons that hold the
 * same numbers and most of its distinctive words (inverted indexes built
 * once). The bigram test then decides, as in learn. Exact copies (same
 * normalised text) count at any length.
 *
 * Only the user's own lessons take part. A line that arrived from a shared
 * space, the miner or anything that is not this machine's session is left
 * out: promoting it would rewrite a third party's text as the user's own
 * lesson, valid for every project, and drop the origin recall shows for it.
 *
 * Read-only and pure: it suggests, it never moves anything.
 */
export function findPromotionCandidates(
  neurons: Neuron[],
  seedIds: Iterable<string>,
  max: number = MAX_PROMOTION_CANDIDATES
): PromotionCandidate[] {
  const semillasIds = new Set(seedIds);
  if (semillasIds.size === 0) return [];

  type Lesson = { neuron: string; kind: LessonKind; id: string; text: string; norm: string; conf: number };
  const lecciones: Lesson[] = [];
  for (const n of neurons) {
    if (!n || n.type !== 'project') continue;
    const retirada = (t: string) => !!n.entry_status?.[entryId(t)];
    for (const f of n.facts || []) {
      if (!f?.text || f.status === 'superseded' || f.status === 'retracted') continue;
      if (f.source && f.source !== 'session') continue;   // not the user's own: never promoted
      lecciones.push({ neuron: n.id, kind: 'fact', id: f.id || factId(f.text), text: f.text, norm: normLesson(f.text), conf: Math.max(1, f.confirmations ?? 1) });
    }
    for (const [kind, lista] of [['pattern', n.patterns], ['error', n.errors]] as const) {
      for (const t of lista || []) {
        if (!t || retirada(t)) continue;
        if (n.entry_source?.[entryId(t)]) continue;   // a teammate's or the miner's: never promoted
        lecciones.push({ neuron: n.id, kind, id: entryId(t), text: t, norm: normLesson(t), conf: 1 });
      }
    }
  }

  // Inverted indexes built once: word → lessons, number → lessons, text → lessons.
  const porPalabra = new Map<string, number[]>();
  const porNumero = new Map<string, number[]>();
  const porTexto = new Map<string, number[]>();
  const palabras: Array<Set<string>> = [];
  lecciones.forEach((l, i) => {
    const ws = lessonWords(l.norm);
    palabras.push(new Set(ws));
    for (const w of ws) (porPalabra.get(w) || porPalabra.set(w, []).get(w)!).push(i);
    for (const n of lessonNumbers(l.norm)) (porNumero.get(n) || porNumero.set(n, []).get(n)!).push(i);
    (porTexto.get(l.norm) || porTexto.set(l.norm, []).get(l.norm)!).push(i);
  });
  const comun = Math.max(PROMOTION_COMMON_WORD.min, Math.ceil(lecciones.length * PROMOTION_COMMON_WORD.share));

  /**
   * The lessons worth a bigram test against seed `s`. Two filters, both
   * cheaper than one Dice count and both implied by what follows it:
   *  - numbers: a near copy must carry the same numbers (the guard below), so
   *    it must hold every number the seed holds — an intersection of postings;
   *  - words: it must share most of the seed's distinctive words.
   * Templated text ("module 155 uses table 5…" ×24,000) is exactly where a
   * plain rare-word probe degrades into comparing against everything.
   */
  const candidatosDe = (s: number): number[] => {
    const semilla = lecciones[s];
    const nums = lessonNumbers(semilla.norm);
    const distintivas = [...palabras[s]].filter(w => (porPalabra.get(w)?.length ?? 0) <= comun);
    // Nothing to tell copies apart by — every word is everywhere — means
    // exact copies only, even when it holds a number: "2026" alone would
    // otherwise send it against every lesson written this year.
    if (distintivas.length === 0) return [];
    const minimo = Math.ceil(distintivas.length * PROMOTION_MIN_OVERLAP);
    let base: number[] | null = null;
    if (nums.length) {
      const listas = nums.map(n => porNumero.get(n) || []).sort((a, b) => a.length - b.length);
      let inter = new Set(listas[0]);
      for (const l of listas.slice(1)) { const otra = new Set(l); inter = new Set([...inter].filter(i => otra.has(i))); }
      base = [...inter];
    }
    const fuera = (i: number) => lecciones[i].neuron === semilla.neuron || lecciones[i].norm === semilla.norm;
    if (base) {
      return base.filter(i => !fuera(i) && distintivas.reduce((n, w) => n + (palabras[i].has(w) ? 1 : 0), 0) >= minimo);
    }
    const cuenta = new Map<number, number>();
    for (const w of distintivas) for (const i of porPalabra.get(w)!) cuenta.set(i, (cuenta.get(i) || 0) + 1);
    return [...cuenta].filter(([i, n]) => n >= minimo && !fuera(i)).map(([i]) => i);
  };

  const semillas = lecciones.map((_, i) => i).filter(i => semillasIds.has(lecciones[i].neuron)).slice(0, MAX_PROMOTION_SEEDS);
  const usadas = new Set<number>();
  const grupos: Array<{ miembros: number[]; similarity: number }> = [];

  for (const s of semillas) {
    if (usadas.has(s)) continue;
    const semilla = lecciones[s];
    // Best copy per OTHER project neuron.
    const mejor = new Map<string, { i: number; sim: number }>();
    const anotar = (i: number, sim: number) => {
      const l = lecciones[i];
      if (l.neuron === semilla.neuron) return;
      const prev = mejor.get(l.neuron);
      if (!prev || sim > prev.sim) mejor.set(l.neuron, { i, sim });
    };
    for (const i of porTexto.get(semilla.norm) || []) anotar(i, 1);
    if (semilla.text.length >= NEAR_DUP_MIN_LENGTH) {
      // Across projects, a copy that disagrees on a number is another lesson
      // ("the 2.5 index" vs "the 2.6 index"): the same guard name matching uses.
      const pool = candidatosDe(s)
        .filter(i => sameNumbers(semilla.text, lecciones[i].text))
        .map(i => ({ id: String(i), text: lecciones[i].text }));
      for (const hit of nearDuplicatesAmong(semilla.text, pool)) anotar(Number(hit.id), hit.similarity);
    }
    if (mejor.size === 0) continue;
    const miembros = [s, ...[...mejor.values()].map(m => m.i)];
    for (const m of miembros) usadas.add(m);
    grupos.push({ miembros, similarity: Math.min(...[...mejor.values()].map(m => m.sim)) });
  }

  return grupos
    .map(g => {
      const ls = g.miembros.map(i => lecciones[i]);
      const rep = [...ls].sort((a, b) => (b.conf - a.conf) || (b.text.length - a.text.length))[0];
      return {
        kind: rep.kind,
        text: rep.text,
        neurons: ls.map(l => l.neuron),
        entry_ids: ls.map(l => l.id),
        similarity: g.similarity,
        confirmations: ls.reduce((n, l) => n + l.conf, 0),
      };
    })
    .sort((a, b) => (b.neurons.length - a.neurons.length) || (b.confirmations - a.confirmations)
      || (b.similarity - a.similarity) || (a.text < b.text ? -1 : 1))
    .slice(0, max);
}

export type Indexer = (neuron: Neuron) => Promise<void> | void;

/**
 * Called after a write so shared neurons can append a note to the team log.
 * A hook rather than a direct call, because the sync layer needs the Cortex
 * and the Cortex would then need the sync layer.
 */
export type Emitter = (
  neuronId: string,
  change:
    | { kind: 'fact'; text: string; fid: string; conf: number; at: string; src?: string; keys?: string[]; shelf?: ShelfLife; reference?: SourceReference; temporal?: Fact['temporal']; verification_invalidated_at?: string }
    | { kind: 'status'; fid: string; to: 'superseded' | 'retracted'; at: string; why?: string }
    | { kind: 'decision'; text: string; why?: string; at: string }
    | { kind: 'pattern'; text: string; at: string }
    | { kind: 'error'; text: string; at: string }
    | { kind: 'debt'; text: string; at: string }
    | { kind: 'map'; text: string; at: string }
    | { kind: 'error_purge'; key: string; at: string }
    | { kind: 'debt_purge'; key: string; at: string }
    | { kind: 'decision_purge'; key: string; at: string }
    | { kind: 'pattern_purge'; key: string; at: string }
    /** A line was checked against its source and still holds (shelf life). `at` is the check. */
    | { kind: 'verify'; eid: string; ekind: 'fact' | 'entry'; at: string; verification?: Verification }
) => Promise<void> | void;

/**
 * Called after a neuron file is deleted, so the search index drops its
 * chunks. The mirror of Indexer: without it a forgotten neuron kept
 * answering recall until the next full rebuild.
 */
export type Remover = (neuronId: string) => Promise<void> | void;

/** Where a fact's lifecycle stands, for "take the furthest-along status". */
function statusRank(status?: FactStatus): number {
  return status === 'retracted' ? 2 : status === 'superseded' ? 1 : 0;
}

function earliestOf(a: string | undefined, b: string | undefined): string {
  if (!a) return b || '';
  if (!b) return a;
  return a < b ? a : b;
}

function copyFact(f: Fact): Fact {
  const out: Fact = { ...f };
  if (f.reference) out.reference = { ...f.reference };
  if (f.verification) out.verification = { ...f.verification, ...(f.verification.reference ? { reference: { ...f.verification.reference } } : {}) };
  if (f.keys) out.keys = [...f.keys];
  if (f.supersedes) out.supersedes = [...f.supersedes];
  return out;
}

/** Content hashes of every entry that can carry a date or a retirement. */
function liveEntryKeys(n: Neuron): Set<string> {
  return new Set([
    ...n.decisions.map(d => d.text || ''),
    ...n.patterns, ...n.preferences,
    ...(n.errors || []), ...(n.debts || []),
  ].map(entryId));
}

/**
 * Everything of `source` folded into `target`, as a new object.
 *
 * Shared by restoreNeuron (a quarantine copy back over a neuron that was
 * re-created since) and mergeNeurons (two neurons that turned out to be one
 * topic). Pure on purpose: neither input is touched, so the caller can diff
 * the result against what it had and emit only what actually moved.
 *
 * Facts line up by id (the content hash), falling back to normalised text;
 * on a collision the target's telling stays but takes the furthest-along
 * status (active < superseded < retracted) and the earliest `added`, and the
 * keys are unioned. Everything else is a set union keyed by normalised text
 * with the target's order first. Local observations (heat, access_count)
 * combine as max and sum; identity (id, name, domain, type) is the target's.
 */
export function unionNeuron(target: Neuron, source: Neuron): {
  neuron: Neuron;
  moved: { facts: number; decisions: number; patterns: number; preferences: number; errors: number; debts: number; tags: number; map: 0 | 1 };
} {
  const moved = { facts: 0, decisions: 0, patterns: 0, preferences: 0, errors: 0, debts: 0, tags: 0, map: 0 as 0 | 1 };

  // ── Facts ──
  const facts: Fact[] = target.facts.map(copyFact);
  const byId = new Map<string, Fact>();
  const byText = new Map<string, Fact>();
  for (const f of facts) {
    byId.set(f.id || factId(f.text), f);
    byText.set(normalizeText(f.text), f);
  }
  for (const sf of source.facts || []) {
    const sid = sf.id || factId(sf.text);
    const hit = byId.get(sid) || byText.get(normalizeText(sf.text));
    if (!hit) {
      const copia = copyFact(sf);
      copia.id = sid;
      facts.push(copia);
      byId.set(sid, copia);
      byText.set(normalizeText(sf.text), copia);
      moved.facts++;
      continue;
    }
    if (statusRank(sf.status) > statusRank(hit.status)) {
      hit.status = sf.status;
      if (sf.revised) hit.revised = sf.revised;
      if (sf.revision_note) hit.revision_note = sf.revision_note;
      if (sf.superseded_by) hit.superseded_by = sf.superseded_by;
    }
    hit.added = earliestOf(hit.added, sf.added);
    // Two copies of one line: the better-witnessed count stands. Summing
    // would count twice the sessions both copies may have seen.
    const conf = Math.max(hit.confirmations ?? 1, sf.confirmations ?? 1);
    if (conf > 1) hit.confirmations = conf;
    const keys = normalizeKeys([...(hit.keys || []), ...(sf.keys || [])]);
    if (keys.length) hit.keys = keys; else delete hit.keys;
    // The later check is the newer evidence; the more volatile explicit class
    // wins, as in a team space (a needless warning is cheaper than a missing one).
    mergeFactEvidence(hit, sf);
    const vida = mostVolatile(hit.shelf_life, sf.shelf_life);
    if (vida) hit.shelf_life = vida;
  }

  // ── Decisions: by normalised text, the target's rationale wins ──
  const decisions: Decision[] = target.decisions.map(d => ({ ...d }));
  const vistas = new Set(decisions.map(d => normalizeText(d.text)));
  for (const d of source.decisions || []) {
    const k = normalizeText(d.text);
    if (vistas.has(k)) continue;
    vistas.add(k);
    decisions.push({ ...d });
    moved.decisions++;
  }

  // ── Plain string lists: set union, target order first ──
  const unir = (a: string[], b: string[]): { out: string[]; added: number } => {
    const out = [...a];
    const seen = new Set(a.map(normalizeText));
    let added = 0;
    for (const t of b) {
      const k = normalizeText(t);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
      added++;
    }
    return { out, added };
  };
  const patterns = unir(target.patterns || [], source.patterns || []);
  const preferences = unir(target.preferences || [], source.preferences || []);
  const errors = unir(target.errors || [], source.errors || []);
  const debts = unir(target.debts || [], source.debts || []);
  const tags = unir(target.tags || [], source.tags || []);
  moved.patterns = patterns.added;
  moved.preferences = preferences.added;
  moved.errors = errors.added;
  moved.debts = debts.added;
  moved.tags = tags.added;

  const neuron: Neuron = {
    ...target,
    facts,
    decisions,
    patterns: patterns.out,
    preferences: preferences.out,
    errors: errors.out,
    debts: debts.out,
    tags: tags.out,
    connections: [...new Set([...(target.connections || []), ...(source.connections || [])])]
      .filter(c => c !== target.id && c !== source.id),
    summary: target.summary || source.summary || '',
    heat: Math.max(target.heat || 0, source.heat || 0),
    access_count: (target.access_count || 0) + (source.access_count || 0),
    created: earliestOf(target.created, source.created) || now(),
    last_accessed: now(),
  };

  // ── Sidecars: union, then pruned to what is actually in the neuron ──
  const vivos = liveEntryKeys(neuron);
  const fechas: Record<string, string> = {};
  for (const [k, v] of Object.entries(source.entry_dates || {})) fechas[k] = v;
  for (const [k, v] of Object.entries(target.entry_dates || {})) fechas[k] = earliestOf(fechas[k], v);
  const fechasVivas: Record<string, string> = {};
  for (const k of Object.keys(fechas).sort()) if (vivos.has(k)) fechasVivas[k] = fechas[k];
  neuron.entry_dates = fechasVivas;

  const estados: Record<string, EntryRetirement> = { ...(source.entry_status || {}), ...(target.entry_status || {}) };
  const estadosVivos: Record<string, EntryRetirement> = {};
  for (const k of Object.keys(estados).sort()) if (vivos.has(k)) estadosVivos[k] = estados[k];
  if (Object.keys(estadosVivos).length) neuron.entry_status = estadosVivos;
  else delete neuron.entry_status;

  // Usar ambos pares originales: una fecha nueva y una fuente vieja no se mezclan.
  neuron.entry_verified = target.entry_verified;
  neuron.entry_verification = target.entry_verification;
  mergeEntryEvidence(neuron, source, vivos);

  const origenes: Record<string, string> = { ...(source.entry_source || {}), ...(target.entry_source || {}) };
  const origenesVivos: Record<string, string> = {};
  for (const k of Object.keys(origenes).sort()) if (vivos.has(k)) origenesVivos[k] = origenes[k];
  if (Object.keys(origenesVivos).length) neuron.entry_source = origenesVivos;
  else delete neuron.entry_source;

  // ── Map: the target's if it has one, else the source's ──
  if (target.map) neuron.map = { ...target.map };
  else if (source.map) { neuron.map = { ...source.map }; moved.map = 1; }
  else delete neuron.map;

  return { neuron, moved };
}

/**
 * Aliases a future question may use, as stored: trimmed, lower-cased, at
 * most 40 characters each, unique, at most eight. Order is kept.
 */
export function normalizeKeys(keys?: string[]): string[] {
  const out: string[] = [];
  for (const k of keys || []) {
    const v = String(k || '').trim().toLowerCase().slice(0, 40);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= 8) break;
  }
  return out;
}

export class Cortex {
  /**
   * Optional hook invoked after every write. Wiring it here — rather than
   * calling the search engine from each caller — is what guarantees the miner
   * path gets indexed too. Before this, the miner wrote straight to disk and
   * 91% of the brain never reached the index.
   */
  private indexer: Indexer | null = null;
  private emitter: Emitter | null = null;
  private remover: Remover | null = null;

  /**
   * What this session has actually written, for an honest consolidate().
   * One per Cortex when a process serves one conversation; in the daemon one
   * Cortex serves every client, so the tally in force is the one the
   * connection carries (sessionScope) — otherwise whoever consolidated first
   * would log, and link with synapses, what the other conversations wrote.
   */
  private ownTally: SessionTally = newTally();
  private get tally(): SessionTally {
    return sessionScope.getStore()?.tally ?? this.ownTally;
  }

  constructor(private brain: Brain) {}

  /** Facts, decisions and neurons touched since the last consolidation. */
  sessionTally(): { facts: number; decisions: number; topics: string[] } {
    return {
      facts: this.tally.facts,
      decisions: this.tally.decisions,
      topics: [...this.tally.topics],
    };
  }

  resetSessionTally(): void {
    const t = this.tally;
    t.facts = 0;
    t.decisions = 0;
    t.topics.clear();
  }

  setIndexer(indexer: Indexer | null): void {
    this.indexer = indexer;
  }

  setEmitter(emitter: Emitter | null): void {
    this.emitter = emitter;
  }

  setRemover(remover: Remover | null): void {
    this.remover = remover;
  }

  private async unindex(neuronId: string): Promise<void> {
    if (!this.remover) return;
    try {
      await this.remover(neuronId);
    } catch {
      // The index is derived data; a stale chunk is a nuisance, not a loss.
    }
  }

  /**
   * Copy a whole neuron to .quarantine/ with a timestamp, before anything
   * destructive. Same stamp format everywhere, so restoreNeuron can pick the
   * newest copy by name alone. Sealed when encryption at rest is on; throws
   * (and the caller removes nothing) when it is on and the key is missing.
   */
  private async quarantine(neuron: Neuron): Promise<string> {
    return writeQuarantine(this.brain.paths.quarantine, neuron.id, neuron, 'whole');
  }

  /** Neuron files that exist and could not be parsed, seen by this process (2.11). */
  private skipped = new Map<string, UnreadableNeuron>();

  /** Where a good copy of a neuron may be: the newest backup, or a quarantine copy. */
  async recoveryHint(id: string): Promise<string> {
    const partes: string[] = [];
    try {
      const copias = (await listQuarantine(this.brain.paths.quarantine, id)).filter(c => c.kind === 'whole');
      if (copias.length) partes.push(`a whole copy is in quarantine (${path.join(this.brain.paths.quarantine, copias[0].file)}; crbro_forget restore:true brings it back once the bad file is moved aside)`);
    } catch { /* no quarantine */ }
    try {
      const dir = resolveBackupDir(this.brain.paths.root);
      const b = (await listBackups(dir))[0];
      if (b) partes.push(`the newest backup is ${b.path} (npx crbro-memory backup restore "${b.file}" --into <empty folder>, then copy cortex/${id}.json back)`);
    } catch { /* no backups */ }
    const donde = partes.length ? `Recovery: ${partes.join('; or ')}.` : 'No backup or quarantine copy was found.';
    return `${donde} Or fix the JSON by hand (a UTF-8 byte-order mark is accepted since 2.11).`;
  }

  private async noteUnreadable(id: string, err: unknown): Promise<UnreadableNeuron> {
    const info: UnreadableNeuron = {
      id,
      path: this.brain.paths.neuron(id),
      error: err instanceof CorruptJSONError ? err.reason : (err as Error)?.message || String(err),
      recovery: await this.recoveryHint(id),
    };
    this.skipped.set(id, info);
    return info;
  }

  /**
   * Unreadable neuron files: the ones readers met and skipped since this
   * process started (default), or every one on disk now (`scan: true`).
   * Callers that list or search the cortex surface these instead of failing.
   */
  async unreadable(options?: { scan?: boolean }): Promise<UnreadableNeuron[]> {
    if (options?.scan) {
      for (const id of await listJSONFiles(this.brain.paths.cortex)) {
        try {
          await readJSON<Neuron>(this.brain.paths.neuron(id));
          this.skipped.delete(id);
        } catch (err) {
          await this.noteUnreadable(id, err);
        }
      }
    }
    // A file fixed since it was seen is no longer reported.
    const out: UnreadableNeuron[] = [];
    for (const [id, info] of this.skipped) {
      try {
        await readJSON<Neuron>(this.brain.paths.neuron(id));
        this.skipped.delete(id);
      } catch {
        out.push(info);
      }
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** A strict read for write paths: null when absent, UnreadableNeuronError when corrupt. */
  private async readStrict(id: string): Promise<Neuron | null> {
    try {
      return await readJSON<Neuron>(this.brain.paths.neuron(id));
    } catch (err) {
      if (!(await fileExists(this.brain.paths.neuron(id)))) return null;
      const info = await this.noteUnreadable(id, err);
      throw new UnreadableNeuronError(id, info.path, info.recovery, info.error);
    }
  }

  /**
   * updateJSON on a neuron, with a corrupt file turned into an error that
   * names it and says where a good copy is.
   */
  private async updateNeuron(id: string, mutate: (current: Neuron | null) => Promise<Neuron | null> | Neuron | null): Promise<Neuron | null> {
    try {
      return await updateJSON<Neuron>(this.brain.paths.neuron(id), mutate);
    } catch (err) {
      if (err instanceof CorruptJSONError) {
        const info = await this.noteUnreadable(id, err);
        throw new UnreadableNeuronError(id, info.path, info.recovery, info.error);
      }
      throw err;
    }
  }

  /** Resolution for write paths: exact id first, then the name; a corrupt match is an error, not a miss. */
  private async resolveForWrite(ref: string): Promise<Neuron | null> {
    return (await this.readStrict(ref)) || (await this.findByName(ref, { strict: true }));
  }

  /** The neuron was deleted between resolution and the lock: a write must not bring it back. */
  private deletedMeanwhile(id: string): Error {
    return new Error(`Neuron "${id}" was deleted while this write was in progress. Nothing was written, so it was not brought back.`);
  }

  /** Remove the neuron file, drop its chunks, and keep the manifest honest. */
  private async deleteNeuronFile(id: string): Promise<void> {
    await deleteJSON(this.brain.paths.neuron(id));
    await this.unindex(id);
    const manifest = await this.brain.getManifest();
    await this.brain.updateManifest({ total_neurons: Math.max(0, manifest.total_neurons - 1) });
  }

  private async emit(neuronId: string, change: Parameters<Emitter>[1]): Promise<void> {
    if (!this.emitter) return;
    try {
      await this.emitter(neuronId, change);
    } catch {
      // El emisor solo falla si no logró registrar la entrega persistente.
      // La nota local sigue guardada, pero no se puede confirmar éxito total.
      throw new Error('Local change saved, but shared delivery could not be recorded. Check local storage before retrying.');
    }
  }

  /**
   * Fusionar contra la versión leída dentro del mismo bloqueo de escritura.
   * Un snapshot calculado antes del bloqueo puede borrar un learn o retiro.
   */
  async mergeFromSync(nid: string, ops: Op[]): Promise<{ report: MergeReport; created: boolean }> {
    let report!: MergeReport;
    let created = false;
    const saved = await this.updateNeuron(nid, current => {
      created = current === null;
      const merged = applyOps(current, ops, { id: nid });
      report = merged.report;
      const neuron = merged.neuron;
      return neuron;
    });
    if (saved) await this.reindex(saved);
    return { report, created };
  }

  private async reindex(neuron: Neuron): Promise<void> {
    if (!this.indexer) return;
    try {
      // Heat lives in the derived heat state since 2.11 and is no longer
      // rewritten into every neuron file; the index gets the current value.
      const h = (await this.heatMap()).get(neuron.id);
      await this.indexer(h === undefined || h === neuron.heat ? neuron : { ...neuron, heat: h });
    } catch {
      // Indexing must never break a write. The index is derived data.
    }
  }

  private heatCache: { mtime: number; map: Map<string, number> } | null = null;

  /**
   * id → heat from the derived heat state (prefrontal/heat_state.json),
   * cached on the file's mtime. Empty when it was never computed: readers
   * then fall back to the heat stored in the neuron, as before 2.11.
   */
  async heatMap(): Promise<Map<string, number>> {
    const file = path.join(this.brain.paths.prefrontal, 'heat_state.json');
    let mtime = 0;
    try { mtime = (await fsp.stat(file)).mtimeMs; } catch { return new Map(); }
    if (this.heatCache && this.heatCache.mtime === mtime) return this.heatCache.map;
    const state = await readHeatState(this.brain).catch(() => null);
    const map = new Map<string, number>();
    for (const [id, e] of Object.entries(state?.neurons || {})) map.set(id, e.heat);
    this.heatCache = { mtime, map };
    return map;
  }

  /**
   * Get a neuron by ID.
   */
  async get(id: string): Promise<Neuron | null> {
    // Even a read touches the file (access time and count), so it goes through
    // the same locked read-modify-write as everything else.
    return this.updateNeuron(id, current => {
      if (!current) return null;
      current.last_accessed = now();
      current.access_count = (current.access_count || 0) + 1;
      return current;
    });
  }

  /**
   * Get a neuron by ID without updating access stats.
   *
   * Tolerant (2.11): a file that exists and cannot be parsed reads as null
   * and is recorded in unreadable(), so one truncated neuron no longer takes
   * down recall, inspect or consolidate. Write paths use a strict read.
   */
  async peek(id: string): Promise<Neuron | null> {
    try {
      return await readJSON<Neuron>(this.brain.paths.neuron(id));
    } catch (err) {
      // A reference that is not a usable file name ("a:b" on Windows) is a miss, not a corrupt neuron.
      if (await fileExists(this.brain.paths.neuron(id))) await this.noteUnreadable(id, err);
      return null;
    }
  }

  /**
   * Find a neuron by name.
   *
   * Returns null rather than guessing. That is the point: the previous
   * implementation fell back to substring containment in either direction, so
   * a two-word topic landed inside any long id that happened to contain it —
   * a short name like "SEO" was swallowed by a sixty-character neuron whose
   * title merely mentioned it.
   * Knowledge written into the wrong neuron is recalled attributed to the
   * wrong neuron, and no amount of index tuning repairs that. A wrong guess
   * is worse than a new neuron.
   */
  async findByName(name: string, options?: { type?: NeuronType; strict?: boolean }): Promise<Neuron | null> {
    const r = await this.resolveTopic(name, options);
    if (!r) return null;
    return options?.strict ? this.readStrict(r.id) : this.peek(r.id);
  }

  /**
   * Which existing neuron a topic names, without reading any neuron unless
   * two candidates tie. In order, for each slug the name may be filed under
   * (current rule, the 2.10 rule, the pre-1.x accent-mangling rule):
   *
   *  1. `id`   — the slug IS an existing id ("project_crbro");
   *  2. `name` — an id minus its type prefix equals the slug;
   *  3. `variant` — the same identifier written with or without underscores
   *     or a plural (see nameVariantKey). Never a letter or a number apart.
   *
   * Several neurons of different types on one name (project_react and
   * tech_react): the requested type wins, then the type an id-shaped topic
   * names, then the type the name implies; failing that the most used, and
   * the others come back in `ambiguous` so the caller can say so.
   */
  async resolveTopic(name: string, options?: { type?: NeuronType }): Promise<{ id: string; resolved_by: 'id' | 'name' | 'variant'; ambiguous?: string[] } | null> {
    const cands = slugCandidates(name);
    if (cands.length === 0) return null;
    const ids = await listJSONFiles(this.brain.paths.cortex);
    const idSet = new Set(ids);
    const bareOf = (id: string) => id.replace(TYPE_PREFIX_RE, '');
    const typeOf = (id: string): NeuronType | null => typeOfIdShape(id);
    const prefer: NeuronType[] = [];
    if (options?.type) prefer.push(options.type);
    const shape = typeOfIdShape(cands[0]);
    if (shape) prefer.push(shape);
    prefer.push(inferNeuronType(name));

    const pick = async (matches: string[], resolved_by: 'name' | 'variant') => {
      if (matches.length === 1) return { id: matches[0], resolved_by };
      for (const t of prefer) {
        const delTipo = matches.filter(id => typeOf(id) === t);
        if (delTipo.length === 1) return { id: delTipo[0], resolved_by, ambiguous: matches.filter(m => m !== delTipo[0]) };
      }
      let best: { id: string; uses: number } | null = null;
      for (const id of [...matches].sort()) {
        const n = await this.peek(id);
        const uses = n?.access_count || 0;
        if (!best || uses > best.uses) best = { id, uses };
      }
      return { id: best!.id, resolved_by, ambiguous: matches.filter(m => m !== best!.id) };
    };

    for (const s of cands) {
      if (idSet.has(s)) return { id: s, resolved_by: 'id' as const };
      // An id-shaped slug also matches an id that carries its prefix twice
      // ("project_x" → project_project_x, made by 2.10 from such a topic):
      // that one's bare id is the slug itself.
      const bare = ids.filter(id => bareOf(id) === s);
      if (bare.length) return pick(bare, 'name');
    }

    const key = nameVariantKey(cands[0].replace(TYPE_PREFIX_RE, ''));
    if (key.length >= 4) {
      const variantes = ids.filter(id => nameVariantKey(bareOf(id)) === key);
      if (variantes.length) return pick(variantes, 'variant');
    }
    return null;
  }

  /**
   * Create a new neuron.
   * Refuses to clobber: two different names can slugify to the same id, and
   * the old code wrote straight over the existing file, losing every fact in it.
   */
  async create(name: string, type: NeuronType, domain: string, summary?: string): Promise<Neuron> {
    const id = neuronId(name, type);

    // Check-then-create has to happen inside the lock, or two clients starting
    // the same topic at the same moment both think they are the first.
    let creada = false;
    const neuron = await this.updateNeuron(id, current => {
      if (current) return null;
      creada = true;
      return {
        id,
        name,
        domain,
        type,
        created: now(),
        last_accessed: now(),
        access_count: 1,
        heat: 0.5, // Initial heat
        summary: summary || '',
        facts: [],
        decisions: [],
        patterns: [],
        preferences: [],
        connections: [],
        tags: [],
        errors: [],
        debts: [],
        entry_dates: {},
      };
    });

    if (creada) {
      // Only count a neuron that was really created, or the manifest drifts.
      const manifest = await this.brain.getManifest();
      await this.brain.updateManifest({ total_neurons: manifest.total_neurons + 1 });
    }

    return neuron as Neuron;
  }

  /**
   * Learn — add a fact, decision, pattern or preference to a neuron.
   * Creates the neuron if it does not exist.
   */
  async learn(
    topic: string,
    type: 'fact' | 'decision' | 'pattern' | 'preference' | 'error' | 'debt',
    content: string,
    options?: {
      confidence?: number;
      domain?: string;
      rationale?: string;
      neuronType?: NeuronType;
      /** Facts only: words a future question may use that the text does not contain. Indexed, never displayed. */
      keys?: string[];
      /**
       * On an exact-duplicate fact, replace its stored keys with `keys`
       * instead of merging them. Local only: materialize unions keys across
       * teammates, so a removed alias does not propagate to their brains.
       */
      keysReplace?: boolean;
      /** Write to this exact neuron and skip name resolution entirely. */
      neuronId?: string;
      /** Who is writing: 'session' (default), 'miner', 'manual'. */
      source?: string;
      reference?: SourceReference;
      temporal?: Fact['temporal'];
      /** Ids or verbatim texts of facts this one replaces. */
      supersedes?: string[];
      /**
       * Facts only: how fast this value goes stale, when the caller says so.
       * Stored only when given; absent, the class is inferred from the text at
       * read time. On an exact duplicate a different value replaces the stored one.
       */
      shelfLife?: ShelfLife;
      /**
       * Create the neuron when the topic is unknown. Default true.
       * The miner passes false: an automated pass guessing at topic names is
       * how a brain ends up with a thousand neurons called things like
       * `lang_pool_8_ball`, each of them shorter -- and therefore
       * easier to retrieve -- than the knowledge that matters.
       */
      createIfMissing?: boolean;
    }
  ): Promise<{
    neuron: Neuron | null;
    /**
     * `skipped` — no neuron and createIfMissing was false.
     * `skipped_retired` — the text matches a fact or entry that was retired
     * (superseded or retracted); nothing was written. Re-learning a retired
     * line silently would undo a deliberate revision; the caller decides,
     * with `skipped_retired` in hand, whether to reactivate it instead.
     */
    action: 'created' | 'updated' | 'skipped' | 'skipped_retired';
    superseded: number;
    /** Supersedes targets that matched no active fact — a silent miss no more. */
    supersedes_unmatched: string[];
    /**
     * Active facts this one closely resembles (Dice ≥ 0.8). The fact is
     * stored anyway — the brain never refuses knowledge — but the caller is
     * told, so it can retire the older telling with supersedes/revise
     * instead of leaving two versions competing on recall.
     */
    near_duplicates: Array<{ id: string; similarity: number; preview: string }>;
    redacted: string[];
    /** The exact text (case-insensitive) was already an active fact of the neuron. */
    duplicate: boolean;
    /** An exact-duplicate fact had its confidence or keys changed by this call. */
    updated_in_place: boolean;
    /** Set when the text matches a retired fact/entry; nothing was written. */
    skipped_retired: { id: string; status: 'superseded' | 'retracted'; revised?: string; note?: string } | null;
    /** Exact-duplicate fact only: how many times the line has now been learned (2.7). */
    confirmations?: number;
    /** Facts only: the shelf-life class that applies, and whether it was inferred from the text (and by which rule). */
    shelf?: { shelf_life: ShelfLife; inferred: boolean; reason?: ShelfReason };
    /** Compatibilidad de lectura: learn ya no produce esta marca. */
    reconfirmed?: boolean;
    /** An explicit shelf_life was replaced by a less volatile one (team merge restores the more volatile value). */
    shelf_lengthened?: boolean;
    /** How the topic was resolved (2.11): neuron_id, id, name, variant or created. */
    resolved_by?: ResolvedBy;
    /** Other neurons the same name could mean (several types share it); the chosen one is neuron. */
    ambiguous?: string[];
  }> {
    const reference = options?.reference === undefined ? undefined : sanitizeReference(options.reference);
    const temporal = sanitizeTemporal(options?.temporal);
    // Credentials never make it to disk. The sentence around them survives, so
    // "the deploy token is [REDACTED: npm token]" still records that a token
    // exists and what kind — the knowledge without the liability.
    const limpio = redact(content);
    content = limpio.text;

    let action: 'created' | 'updated' | 'skipped' | 'skipped_retired' = 'updated';
    let targetId: string;
    let resolvedBy: ResolvedBy;
    let ambiguous: string[] | undefined;

    // Resolution reads no neuron (2.11): only the id is needed here, and the
    // lock below reads the file anyway. On a 1 MB neuron that was a whole
    // extra parse per learn.
    if (options?.neuronId) {
      // An explicit id is a promise about where the knowledge goes. A typo in
      // it used to fall back to the topic and write somewhere else, silently.
      const nid = options.neuronId.trim();
      const existe = !!nid && !/[\\/]/.test(nid) && await fileExists(this.brain.paths.neuron(nid));
      // The one case an absent id is created: it is exactly the id the topic
      // itself makes ("Tienda" + project_tienda). Anything else would be the
      // knowledge landing somewhere the caller did not name.
      const tipoDelId = existe ? null : typeOfIdShape(nid);
      const mismoId = !!tipoDelId && !!topic.trim() && neuronId(topic, tipoDelId) === nid;
      if (existe) {
        targetId = nid;
        resolvedBy = 'neuron_id';
      } else if (mismoId && options.createIfMissing !== false) {
        targetId = (await this.create(topic, tipoDelId!, options.domain || 'general')).id;
        action = 'created';
        resolvedBy = 'created';
      } else {
        throw new Error(`No neuron with id "${options.neuronId}". Nothing was written. ` +
          'Find the right id with crbro_recall or crbro_inspect view=neurons, or pass only topic to resolve it by name.');
      }
    } else {
      const r = await this.resolveTopic(topic, { type: options?.neuronType });
      if (r) {
        targetId = r.id;
        resolvedBy = r.resolved_by;
        ambiguous = r.ambiguous;
      } else {
        if (options?.createIfMissing === false) {
          return {
            neuron: null, action: 'skipped', superseded: 0,
            supersedes_unmatched: options?.supersedes || [], near_duplicates: [], redacted: limpio.found,
            duplicate: false, updated_in_place: false, skipped_retired: null,
          };
        }
        const nType = options?.neuronType || inferNeuronType(topic);
        const domain = options?.domain || 'general';
        targetId = (await this.create(topic, nType, domain)).id;
        action = 'created';
        resolvedBy = 'created';
      }
    }

    let superseded = 0;
    // Only targets that matched nothing, live or already retired: a retry of
    // a supersedes that already ran finds its target retired, and warning
    // "still live" about it would be a false alarm.
    let supersedesUnmatched: string[] = [];
    let retiradosAhora: string[] = [];
    let gone = false;
    let nearDuplicates: Array<{ id: string; similarity: number; preview: string }> = [];
    let emitir: Parameters<Emitter>[1] | null = null;
    let duplicate = false;
    let updatedInPlace = false;
    let confirmations: number | undefined;
    let shelf: { shelf_life: ShelfLife; inferred: boolean; reason?: ShelfReason } | undefined;
    let shelfLengthened = false;
    const vidaPedida: ShelfLife | undefined = isShelfLife(options?.shelfLife) ? options!.shelfLife : undefined;
    let skippedRetired: { id: string; status: 'superseded' | 'retracted'; revised?: string; note?: string } | null = null;

    // A retired decision, pattern, error or debt must not come back through
    // learn: the sidecar says so, and the index already hides it.
    const retirada = (n: Neuron, text: string): boolean => {
      const k = entryId(text);
      const est = n.entry_status?.[k];
      if (!est) return false;
      skippedRetired = { id: k, status: est.status, revised: est.revised, note: est.note };
      return true;
    };

    // From here on we work on a fresh read inside the lock. Mutating the copy
    // fetched a moment ago and saving it over the top is exactly how a
    // concurrent writer's facts disappeared.
    // Patterns, preferences, errors and debts are plain strings; their date
    // lives in the entry_dates sidecar, keyed by content hash.
    const fechar = (n: Neuron, text: string) => {
      if (!n.entry_dates) n.entry_dates = {};
      n.entry_dates[entryId(text)] = now();
    };
    // Where a non-fact entry came from, when it is not this session (2.7):
    // the sidecar twin of Fact.source. A line written here clears a stale
    // mark, so a teammate's pattern forgotten and re-learned reads as yours.
    const origen = (n: Neuron, text: string) => {
      const k = entryId(text);
      const src = options?.source;
      if (src && src !== 'session' && src !== 'manual') {
        (n.entry_source ||= {})[k] = src;
      } else if (n.entry_source?.[k]) {
        delete n.entry_source[k];
        if (Object.keys(n.entry_source).length === 0) delete n.entry_source;
      }
    };

    // One identity rule for every kind (2.11): the normalised text entryId
    // hashes — whitespace runs collapsed, NFC. Before, a pattern differing by
    // a line break was stored twice under one sidecar key, and a fact with a
    // trailing newline became a second fact.
    const clave = normalizeText(content);
    const mismaEntrada = (t: string) => t === content || normalizeText(t) === clave;
    const claveLower = clave.toLowerCase();
    const contentLower = content.toLowerCase();
    const mismoHecho = (t: string): boolean => {
      if (t.length === content.length && t.toLowerCase() === contentLower) return true;
      // Normalising only shrinks a text, so a shorter one cannot match.
      if (t.length < clave.length || t.length > clave.length * 2 + 16) return false;
      return normalizeText(t).toLowerCase() === claveLower;
    };
    const supersedeDesde = (n: Neuron, propio: { id: string; text: string }) => {
      if (!options?.supersedes?.length) return;
      // A fact never supersedes itself, whatever the caller listed.
      const objetivos = options.supersedes.filter(t =>
        t.trim().toLowerCase() !== propio.id.toLowerCase() && !mismoHecho(t.trim()));
      const r = this.retire(n, objetivos, propio.id, 'superseded');
      superseded = r.count;
      retiradosAhora = r.ids;
      // A target that is already retired was found: a retry of a supersedes
      // that already ran is not a miss.
      const yaRetirado = (t: string) => {
        const w = t.trim().toLowerCase();
        return n.facts.some(f => (f.status === 'superseded' || f.status === 'retracted')
          && ((f.id || factId(f.text)).toLowerCase() === w || f.text.trim().toLowerCase() === w));
      };
      supersedesUnmatched = r.unmatched.filter(t => !yaRetirado(t));
    };

    const actualizada = await this.updateNeuron(
      targetId,
      current => {
        if (!current) {
          gone = true;
          return null;
        }
        const n = current;

        switch (type) {
          case 'fact': {
            const id = factId(content);
            const keys = normalizeKeys(options?.keys);
            const existente = n.facts.find(f => mismoHecho(f.text));
            if (existente && (existente.status === 'superseded' || existente.status === 'retracted')) {
              // The same line was deliberately retired. Re-adding it would
              // undo that revision by accident; report it and write nothing.
              skippedRetired = {
                id: existente.id || factId(existente.text),
                status: existente.status,
                revised: existente.revised,
                note: existente.revision_note,
              };
              return null;
            }
            const isDuplicate = existente !== undefined;
            if (existente) {
              // The same line again: no sibling, but confidence and aliases
              // may be edited in place. The indexer re-indexes the neuron
              // afterwards, keys included.
              duplicate = true;
              // The same line from another session is a second witness (2.7).
              // The same session saying it again is not (a retry, the re-save
              // after a compaction), and neither is the miner re-reading a file.
              const testigo = `${n.id}|${existente.id || factId(existente.text)}`;
              const vistos = (this.tally.witnessed ??= new Set<string>());
              if (options?.source !== 'miner' && !vistos.has(testigo)) {
                existente.confirmations = (existente.confirmations ?? 1) + 1;
              }
              if (options?.source !== 'miner') vistos.add(testigo);
              confirmations = existente.confirmations ?? 1;
              let cambiado = false;
              if (vidaPedida && vidaPedida !== existente.shelf_life) {
                // Lengthening an explicit class (volatile → durable, say). On a
                // shared neuron the more volatile value comes back from the
                // log on the next sync; the server warns about it.
                if (existente.shelf_life && mostVolatile(existente.shelf_life, vidaPedida) === existente.shelf_life) {
                  shelfLengthened = true;
                }
                existente.shelf_life = vidaPedida;
                cambiado = true;
              }
              if (options?.confidence !== undefined && options.confidence !== existente.confidence) {
                existente.confidence = options.confidence;
                cambiado = true;
              }
              if (options?.keysReplace) {
                const actuales = existente.keys || [];
                if (keys.length !== actuales.length || keys.some((k, i) => k !== actuales[i])) {
                  if (keys.length) existente.keys = keys; else delete existente.keys;
                  cambiado = true;
                }
              } else if (keys.length) {
                const merged = normalizeKeys([...(existente.keys || []), ...keys]);
                if (merged.length !== (existente.keys || []).length) {
                  existente.keys = merged;
                  cambiado = true;
                }
              }
              const referenceChanged = reference && JSON.stringify(reference) !== JSON.stringify(existente.reference);
              const temporalChanged = temporal && temporal !== existente.temporal;
              if (referenceChanged || temporalChanged) {
                const previous = mergeCheck(existente, {});
                existente.verification_invalidated_at = new Date(Math.max(Date.now(),
                  Date.parse(previous.verified || '') || 0, Date.parse(previous.verification_invalidated_at || '') || 0)).toISOString();
                delete existente.verified;
                delete existente.verification;
              }
              if (referenceChanged) {
                existente.reference = reference;
                cambiado = true;
              }
              if (temporalChanged) {
                existente.temporal = temporal;
                cambiado = true;
              }
              if (cambiado) {
                // Note for shared neurons: materialize takes max(conf) and
                // unions keys, so lowering confidence or dropping an alias
                // stays local. Documented, not fought — the log is append-only.
                updatedInPlace = true;
                this.tally.topics.add(n.id);
              }
              // Un intento anterior pudo guardar la neurona pero fallar antes
              // de persistir su entrega. Reemitir permite recuperarla incluso
              // tras reiniciar; applyOps deduplica por fid. No es verificación
              // nueva y conserva la fecha original, no la del reintento.
              emitir = { kind: 'fact' as const, text: existente.text, fid: existente.id || id,
                         conf: existente.confidence ?? 1, at: existente.added, src: existente.source, keys: existente.keys,
                         ...(existente.reference ? { reference: existente.reference } : {}),
                         ...(existente.temporal ? { temporal: existente.temporal } : {}),
                         ...(existente.verification_invalidated_at ? { verification_invalidated_at: existente.verification_invalidated_at } : {}),
                         ...(existente.shelf_life ? { shelf: existente.shelf_life } : {}) };
              const sv = shelfOfFact(existente);
              shelf = { shelf_life: sv.shelf, inferred: sv.inferred, ...(sv.reason ? { reason: sv.reason } : {}) };
              // The same line again WITH supersedes: the retry after fixing a
              // mistyped id. It used to skip the retirement in silence, and
              // the old value stayed live while the caller believed it gone.
              supersedeDesde(n, { id: existente.id || factId(existente.text), text: existente.text });
            }
            if (!isDuplicate) {
              supersedeDesde(n, { id, text: content });
              // Near-duplicate check, against what will still be active
              // AFTER supersedes ran — retiring the old telling is exactly
              // the fix this warning exists to suggest, so a properly
              // superseded fact must not re-trigger it.
              nearDuplicates = this.findNearDuplicates(n, content);
              const fact: Fact = {
                text: content,
                confidence: options?.confidence ?? 1.0,
                added: now(),
                source: options?.source || 'session',
                id,
                status: 'active',
              };
              if (options?.supersedes?.length) fact.supersedes = options.supersedes;
              if (keys.length) fact.keys = keys;
              if (vidaPedida) fact.shelf_life = vidaPedida;
              if (reference) fact.reference = reference;
              if (temporal) fact.temporal = temporal;
              const sv = shelfOfFact(fact);
              shelf = { shelf_life: sv.shelf, inferred: sv.inferred, ...(sv.reason ? { reason: sv.reason } : {}) };
              n.facts.push(fact);
              if (fact.source !== 'miner') (this.tally.witnessed ??= new Set<string>()).add(`${n.id}|${id}`);
              this.tally.facts++;
              this.tally.topics.add(n.id);
              emitir = { kind: 'fact' as const, text: content, fid: id,
                         conf: fact.confidence, at: fact.added, src: fact.source, keys: fact.keys,
                         ...(fact.reference ? { reference: fact.reference } : {}),
                         ...(fact.temporal ? { temporal: fact.temporal } : {}),
                         ...(fact.shelf_life ? { shelf: fact.shelf_life } : {}) };
            }
            break;
          }
          case 'decision': {
            if (retirada(n, content)) return null;
            // A retry no longer adds a second copy under the same entry id.
            const previa = n.decisions.find(d => mismaEntrada(d.text || ''));
            if (previa) {
              emitir = { kind: 'decision' as const, text: previa.text, why: previa.rationale || undefined, at: previa.date || now() };
              break;
            }
            const decision: Decision = {
              text: content,
              date: now(),
              rationale: options?.rationale || '',
            };
            n.decisions.push(decision);
            origen(n, content);
            this.tally.decisions++;
            this.tally.topics.add(n.id);
            emitir = { kind: 'decision' as const, text: content,
                       why: options?.rationale, at: decision.date };
            break;
          }
          case 'pattern': {
            if (retirada(n, content)) return null;
            const previo = n.patterns.find(mismaEntrada);
            if (previo === undefined) {
              n.patterns.push(content);
              fechar(n, content);
              origen(n, content);
            }
            const texto = previo ?? content;
            emitir = { kind: 'pattern' as const, text: texto, at: n.entry_dates?.[entryId(texto)] || now() };
            break;
          }
          case 'preference': {
            if (!n.preferences.some(mismaEntrada)) {
              n.preferences.push(content);
              fechar(n, content);
            }
            break;
          }
          case 'error': {
            if (retirada(n, content)) return null;
            if (!n.errors) n.errors = [];
            const previo = n.errors.find(mismaEntrada);
            if (previo === undefined) {
              n.errors.push(content);
              fechar(n, content);
              origen(n, content);
              this.tally.topics.add(n.id);
            }
            const texto = previo ?? content;
            emitir = { kind: 'error' as const, text: texto, at: n.entry_dates?.[entryId(texto)] || now() };
            break;
          }
          case 'debt': {
            if (retirada(n, content)) return null;
            if (!n.debts) n.debts = [];
            const previo = n.debts.find(mismaEntrada);
            if (previo === undefined) {
              n.debts.push(content);
              fechar(n, content);
              origen(n, content);
              this.tally.topics.add(n.id);
            }
            const texto = previo ?? content;
            emitir = { kind: 'debt' as const, text: texto, at: n.entry_dates?.[entryId(texto)] || now() };
            break;
          }
        }

        n.last_accessed = now();
        n.access_count = (n.access_count || 0) + 1;

        if (options?.domain && n.domain === 'general') {
          n.domain = options.domain;
        }

        return n;
      }
    );

    if (gone || !actualizada) throw this.deletedMeanwhile(targetId);
    const final = actualizada;
    if (skippedRetired) {
      // Nothing was written, so nothing to index, emit or tally.
      return {
        neuron: final, action: 'skipped_retired', superseded: 0, supersedes_unmatched: [],
        near_duplicates: [], redacted: limpio.found,
        duplicate: false, updated_in_place: false, skipped_retired: skippedRetired,
        resolved_by: resolvedBy, ...(ambiguous?.length ? { ambiguous } : {}),
      };
    }
    await this.reindex(final);
    // Preferences are never emitted: they are the field most likely to hold a
    // key and the least likely to be worth sharing.
    if (emitir) await this.emit(final.id, emitir);
    // The retirement travels too (2.11), exactly as crbro_revise sends it:
    // before, teammates got the new value and kept the old one as current.
    for (const fid of retiradosAhora) {
      const f = final.facts.find(x => x.id === fid);
      await this.emit(final.id, { kind: 'status', fid, to: 'superseded', at: f?.revised || now() });
    }
    return {
      neuron: final, action, superseded, supersedes_unmatched: supersedesUnmatched,
      near_duplicates: nearDuplicates, redacted: limpio.found,
      duplicate, updated_in_place: updatedInPlace, skipped_retired: null,
      ...(confirmations !== undefined ? { confirmations } : {}),
      ...(shelf ? { shelf } : {}),
      ...(shelfLengthened ? { shelf_lengthened: true } : {}),
      resolved_by: resolvedBy, ...(ambiguous?.length ? { ambiguous } : {}),
    };
  }

  /**
   * Mark facts as no longer current.
   *
   * `superseded` — a newer fact replaces it.
   * `retracted`  — it was never true.
   *
   * Facts are matched by id, and failing that by verbatim text, because the
   * caller usually has the text in front of it and not the hash.
   */
  async revise(
    neuronRef: string,
    targets: string[],
    options?: { status?: FactStatus; note?: string; replacedBy?: string }
  ): Promise<{ neuron: Neuron | null; revised: number; unmatched: string[] }> {
    const neuron =
      await this.resolveForWrite(neuronRef);
    if (!neuron) return { neuron: null, revised: 0, unmatched: targets.slice() };

    const status: FactStatus = options?.status || 'superseded';
    let revised = 0;
    let unmatched: string[] = targets.slice();
    const actualizada = await this.updateNeuron(neuron.id,
      current => {
        if (!current) return null;   // deleted meanwhile: never resurrect it (2.11)
        const n = current;
        const retirado = status === 'active'
          ? this.reactivate(n, targets, options?.note)
          : this.retire(n, targets, options?.replacedBy, status, options?.note);
        revised = retirado.count;
        unmatched = retirado.unmatched;
        if (revised === 0) return null;
        n.last_accessed = now();
        return n;
      }
    );

    if (revised > 0) {
      // Must reindex, or the correction is silently lost on next boot —
      // which is exactly the failure this feature exists to close.
      const n = (actualizada || neuron) as Neuron;
      await this.reindex(n);
      // 'active' is not a retirement, so it is never emitted: StatusOp only
      // moves forward, and on a shared neuron the next sync re-applies the
      // retirement from the log. Reactivation is local; the server says so.
      if (status === 'active') return { neuron: n, revised, unmatched };
      const estado: 'superseded' | 'retracted' =
        status === 'retracted' ? 'retracted' : 'superseded';
      for (const t of targets) {
        const f = n.facts.find(x => (x.id || '') === t || x.text.trim().toLowerCase() === t.trim().toLowerCase());
        if (f?.id) {
          await this.emit(n.id, { kind: 'status', fid: f.id, to: estado, at: f.revised || now(), why: options?.note });
        }
      }
    }

    return { neuron: (actualizada || neuron) as Neuron, revised, unmatched };
  }

  /**
   * Reconfirm: the caller checked these lines against their source and they
   * still hold, so their shelf-life clock restarts now.
   *
   * `facts` match ACTIVE facts by id or exact text (trimmed, case-insensitive);
   * `entries` match live decisions and patterns by entry id or exact text —
   * the two kinds whose class is durable. A retired fact or entry is not
   * verifiable: it comes back in `retired` with its status (reactivate it with
   * status active first, if it holds again), and in `unmatched` like any miss.
   * Preferences, errors and debts never go stale, so there is nothing to
   * reconfirm on them; they are unmatched.
   *
   * Each stamp is emitted as a verify op, so on a shared neuron a teammate's
   * clock restarts too: the fact is shared, and so is the world it describes.
   */
  async verify(
    neuronRef: string,
    targets: { facts?: string[]; entries?: string[]; evidence?: VerificationInput }
  ): Promise<{
    neuron: Neuron | null;
    verified: string[];
    unmatched: string[];
    retired: Array<{ target: string; id: string; status: 'superseded' | 'retracted' }>;
  }> {
    // Validar antes de cualquier escritura, incluida la creación de neuronas.
    const evidence = makeVerification(targets.evidence, now());
    const facts = (targets.facts || []).filter(t => typeof t === 'string');
    const entries = (targets.entries || []).filter(t => typeof t === 'string');
    const neuron = await this.resolveForWrite(neuronRef);
    if (!neuron) return { neuron: null, verified: [], unmatched: [...facts, ...entries], retired: [] };

    const verified: string[] = [];
    let unmatched: string[] = [];
    let retired: Array<{ target: string; id: string; status: 'superseded' | 'retracted' }> = [];
    const emitir: Array<{ eid: string; ekind: 'fact' | 'entry'; at: string; verification: Verification }> = [];

    const actualizada = await this.updateNeuron(neuron.id, current => {
      if (!current) return null;   // deleted meanwhile: never resurrect it (2.11)
        const n = current;
      const cuando = now();
      verified.length = 0; unmatched = []; retired = []; emitir.length = 0;

      for (const t of facts) {
        const w = t.trim().toLowerCase();
        const hits = n.facts.filter(f => (f.id || factId(f.text)).toLowerCase() === w || f.text.trim().toLowerCase() === w);
        const vivos = hits.filter(f => f.status !== 'superseded' && f.status !== 'retracted');
        if (vivos.length === 0) {
          const r = hits.find(f => f.status === 'superseded' || f.status === 'retracted');
          if (r) retired.push({ target: t, id: r.id || factId(r.text), status: r.status as 'superseded' | 'retracted' });
          unmatched.push(t);
          continue;
        }
        for (const f of vivos) {
          f.id = f.id || factId(f.text);
          // Un check explícito posterior al cambio debe sobrevivir incluso
          // cuando ambas llamadas caben en el mismo milisegundo.
          f.verified = new Date(Math.max(Date.parse(cuando), (Date.parse(f.verification_invalidated_at || '') || 0) + 1)).toISOString();
          f.verification = { ...evidence, at: f.verified };
          if (!verified.includes(f.id)) verified.push(f.id);
          emitir.push({ eid: f.id, ekind: 'fact', at: f.verified, verification: f.verification });
        }
      }

      const candidatas = [
        ...n.decisions.map(d => ({ text: d.text || '', ids: [entryId(d.text || ''), ...(d.id ? [d.id] : [])] })),
        ...n.patterns.map(p => ({ text: p, ids: [entryId(p)] })),
      ];
      for (const t of entries) {
        const w = normalizeText(t).toLowerCase();
        const hits = candidatas.filter(c => c.ids.some(i => i.toLowerCase() === w) || normalizeText(c.text).toLowerCase() === w);
        const vivas = hits.filter(c => !n.entry_status?.[entryId(c.text)]);
        if (vivas.length === 0) {
          const r = hits[0];
          const est = r ? n.entry_status?.[entryId(r.text)] : undefined;
          if (r && est) retired.push({ target: t, id: entryId(r.text), status: est.status });
          unmatched.push(t);
          continue;
        }
        for (const c of vivas) {
          const k = entryId(c.text);
          (n.entry_verified ||= {})[k] = cuando;
          (n.entry_verification ||= {})[k] = { ...evidence, at: cuando };
          if (!verified.includes(k)) verified.push(k);
          emitir.push({ eid: k, ekind: 'entry', at: cuando, verification: n.entry_verification[k] });
        }
      }

      if (verified.length === 0) return null;
      n.last_accessed = cuando;
      return n;
    });

    const final = (actualizada || neuron) as Neuron;
    // No reindex: neither the text nor the indexed date changed. `since`
    // filters on when a line was recorded, not on when it was last checked.
    for (const e of emitir) await this.emit(final.id, { kind: 'verify', ...e });
    return { neuron: final, verified: [...verified], unmatched, retired };
  }

  /**
   * Which active facts does this text closely resemble?
   *
   * Warn-only by design. Measured on the reference brain: the heaviest
   * neuron held 293 facts with 1,407 near-duplicate pairs — session
   * summaries retelling the same thing with variations, each version as
   * loud as the others on recall. The fix is the writer retiring the old
   * telling, never the engine merging on its own.
   */
  private findNearDuplicates(
    neuron: Neuron,
    content: string
  ): Array<{ id: string; similarity: number; preview: string }> {
    const activos = neuron.facts
      .filter(f => f.status !== 'superseded' && f.status !== 'retracted' && f.text && f.text !== content)
      .map(f => ({ id: f.id || factId(f.text), text: f.text }));
    return nearDuplicatesAmong(content, activos)
      .slice(0, 5)
      .map(({ id, similarity: s, text }) => ({ id, similarity: s, preview: text.slice(0, 120) }));
  }

  /**
   * Flip matching facts to a non-active status.
   *
   * Also reports which targets matched nothing. Callers pass free text, and
   * a miss used to be indistinguishable from a hit: `supersedes` returned 0
   * without a word, the writer walked away believing the old version was
   * retired, and both versions kept surfacing on recall as equals.
   */
  private retire(
    neuron: Neuron,
    targets: string[],
    replacedBy: string | undefined,
    status: FactStatus,
    note?: string
  ): { count: number; unmatched: string[]; ids: string[] } {
    let count = 0;
    const wanted = targets.map(t => t.trim().toLowerCase());
    const hit = new Set<number>();
    const ids: string[] = [];

    for (const fact of neuron.facts) {
      if (fact.status === 'superseded' || fact.status === 'retracted') continue;

      const fid = fact.id || factId(fact.text);
      const idPos = wanted.indexOf(fid.toLowerCase());
      const textPos = wanted.indexOf(fact.text.trim().toLowerCase());
      if (idPos === -1 && textPos === -1) continue;
      if (idPos !== -1) hit.add(idPos);
      if (textPos !== -1) hit.add(textPos);

      fact.id = fid;
      fact.status = status;
      fact.revised = now();
      if (replacedBy) fact.superseded_by = replacedBy;
      if (note) fact.revision_note = note;
      count++;
      ids.push(fid);
    }

    return { count, unmatched: targets.filter((_, i) => !hit.has(i)), ids };
  }

  /**
   * Bring retired facts back. The inverse of retire: only superseded or
   * retracted facts match, by id or by trimmed lower-cased text. Clears
   * superseded_by (the replacement no longer replaces it) and stamps the
   * revision date; the note, if given, records why it came back.
   */
  private reactivate(
    neuron: Neuron,
    targets: string[],
    note?: string
  ): { count: number; unmatched: string[] } {
    let count = 0;
    const wanted = targets.map(t => t.trim().toLowerCase());
    const hit = new Set<number>();

    for (const fact of neuron.facts) {
      if (fact.status !== 'superseded' && fact.status !== 'retracted') continue;

      const fid = fact.id || factId(fact.text);
      const idPos = wanted.indexOf(fid.toLowerCase());
      const textPos = wanted.indexOf(fact.text.trim().toLowerCase());
      if (idPos === -1 && textPos === -1) continue;
      if (idPos !== -1) hit.add(idPos);
      if (textPos !== -1) hit.add(textPos);

      fact.id = fid;
      fact.status = 'active';
      delete fact.superseded_by;
      fact.revised = now();
      if (note) fact.revision_note = note;
      count++;
    }

    return { count, unmatched: targets.filter((_, i) => !hit.has(i)) };
  }

  /**
   * Retire — or reactivate — decisions, patterns, errors and debts by exact
   * text (trimmed, case-insensitive). These are plain strings, so their
   * status lives in the entry_status sidecar keyed by entryId(text), the
   * same way their dates do. A retired entry stays in the file and leaves
   * recall exactly like a superseded fact; status 'active' deletes the key.
   *
   * Never emitted: the sidecar travels only through the local file and
   * survives a sync because applyOps copies and prunes it.
   */
  async retireEntries(
    neuronRef: string,
    targets: string[],
    options?: { status?: FactStatus; note?: string }
  ): Promise<{ neuron: Neuron | null; revised: number; unmatched: string[] }> {
    const neuron =
      await this.resolveForWrite(neuronRef);
    if (!neuron) return { neuron: null, revised: 0, unmatched: targets.slice() };

    const status: FactStatus = options?.status || 'superseded';
    const wanted = targets.map(t => normalizeText(t).toLowerCase());
    let revised = 0;
    let unmatched: string[] = targets.slice();

    const actualizada = await this.updateNeuron(neuron.id,
      current => {
        if (!current) return null;   // deleted meanwhile: never resurrect it (2.11)
        const n = current;
        const estados: Record<string, EntryRetirement> = n.entry_status || {};
        const hit = new Set<number>();
        const cuando = now();
        const textos = [
          ...n.decisions.map(d => d.text || ''),
          ...n.patterns,
          ...(n.errors || []),
          ...(n.debts || []),
        ];

        for (const t of textos) {
          const pos = wanted.indexOf(normalizeText(t).toLowerCase());
          if (pos === -1) continue;
          const k = entryId(t);
          const retirado = estados[k] !== undefined;
          if (status === 'active') {
            // Only a retired entry can come back.
            if (!retirado) continue;
            delete estados[k];
          } else {
            // An already-retired entry never matches again.
            if (retirado) continue;
            const est: EntryRetirement = { status: status as EntryStatus, revised: cuando };
            if (options?.note) est.note = options.note;
            estados[k] = est;
          }
          hit.add(pos);
          revised++;
        }

        unmatched = targets.filter((_, i) => !hit.has(i));
        if (revised === 0) return null;
        if (Object.keys(estados).length) n.entry_status = estados;
        else delete n.entry_status;
        n.last_accessed = cuando;
        return n;
      }
    );

    const n = (actualizada || neuron) as Neuron;
    // The index drops retired entries (and picks reactivated ones back up).
    if (revised > 0) await this.reindex(n);
    return { neuron: n, revised, unmatched };
  }

  /**
   * Edit a neuron's metadata: summary, domain, tags, name.
   *
   * Only fields that actually differ are written and reported; a call that
   * changes nothing writes nothing. `tags` replaces the whole list — protocol
   * neurons keep their 'priority:'/'source:' tags only if the caller re-sends
   * them. `name` changes the display name only: the id, and with it the file,
   * the synapses, the shared map and the connections, never move. `domain`
   * replaces unconditionally, unlike learn, which only fills in 'general'.
   *
   * Not emitted: NeuronOp is only an announcement, and metadata is local.
   */
  async setMeta(
    neuronRef: string,
    meta: { summary?: string; domain?: string; tags?: string[]; name?: string }
  ): Promise<{ neuron: Neuron | null; changed: Array<'summary' | 'domain' | 'tags' | 'name'>; redacted: string[] }> {
    const neuron =
      await this.resolveForWrite(neuronRef);
    if (!neuron) return { neuron: null, changed: [], redacted: [] };

    let redacted: string[] = [];
    let summary: string | undefined;
    if (meta.summary !== undefined) {
      const limpio = redact(meta.summary);
      summary = limpio.text;
      redacted = limpio.found;
    }
    const tags = meta.tags === undefined
      ? undefined
      : [...new Set(meta.tags.map(t => String(t || '').trim()).filter(Boolean))];
    const domain = meta.domain === undefined ? undefined : meta.domain.trim();
    const name = meta.name === undefined ? undefined : meta.name.trim();

    const changed: Array<'summary' | 'domain' | 'tags' | 'name'> = [];
    const actualizada = await this.updateNeuron(neuron.id,
      current => {
        if (!current) return null;   // deleted meanwhile: never resurrect it (2.11)
        const n = current;
        if (summary !== undefined && summary !== n.summary) {
          n.summary = summary;
          changed.push('summary');
        }
        if (domain !== undefined && domain && domain !== n.domain) {
          n.domain = domain;
          changed.push('domain');
        }
        if (tags !== undefined) {
          const actuales = n.tags || [];
          if (tags.length !== actuales.length || tags.some((t, i) => t !== actuales[i])) {
            n.tags = tags;
            changed.push('tags');
          }
        }
        if (name !== undefined && name && name !== n.name) {
          n.name = name;
          changed.push('name');
        }
        if (changed.length === 0) return null;
        n.last_accessed = now();
        return n;
      }
    );

    const n = (actualizada || neuron) as Neuron;
    // The header chunk carries name and tags; the summary is indexed too.
    if (changed.length > 0) await this.reindex(n);
    return { neuron: n, changed, redacted };
  }

  /**
   * Replace the neuron's system map.
   *
   * Whole-document semantics on purpose: a map that can only be appended to
   * rots the same way facts did — old directions never die. The writer reads
   * the current map, rewrites it, and stores the new truth. Credentials are
   * redacted exactly as in learn.
   */
  async setMap(
    neuronRef: string,
    content: string,
    options?: { domain?: string; neuronType?: NeuronType }
  ): Promise<{ neuron: Neuron | null; action: 'created' | 'updated'; redacted: string[] }> {
    const limpio = redact(content);
    content = limpio.text;

    // peek first, findByName second — the same order as revise and forget.
    // The other way round, an exact neuron id could land on a near-miss whose
    // prefix-stripped id matches first, and the map would be written to one
    // neuron while every reader resolves the other.
    let neuron = await this.resolveForWrite(neuronRef);
    let action: 'created' | 'updated' = 'updated';
    if (!neuron) {
      const nType = options?.neuronType || inferNeuronType(neuronRef);
      neuron = await this.create(neuronRef, nType, options?.domain || 'general');
      action = 'created';
    }

    const cuando = now();
    const vaciar = content.trim() === '';
    const actualizada = await this.updateNeuron(neuron.id,
      current => {
        if (!current) return null;   // deleted meanwhile: never resurrect it (2.11)
        const n = current;
        // An empty map is not a map: writing '' clears it outright, so the
        // reader never meets a document that exists but says nothing.
        if (vaciar) delete n.map;
        else n.map = { text: content, updated: cuando };
        n.last_accessed = cuando;
        n.access_count = (n.access_count || 0) + 1;
        return n;
      }
    );

    if (!actualizada) throw this.deletedMeanwhile(neuron.id);
    const final = actualizada;
    await this.reindex(final);
    // Clearing emits too: an empty map op is the tombstone that wins the LWW
    // on every machine, so a stale copy cannot resurrect the cleared map.
    await this.emit(final.id, { kind: 'map', text: vaciar ? '' : content, at: cuando });
    return { neuron: final, action, redacted: limpio.found };
  }

  /**
   * List all neurons with optional filters, and how many matched before paging.
   *
   * `list` returns only the page, which made every caller report the page size
   * as the total — so a client paging through 1,145 neurons was told there were
   * 50, and stopped. The count here is taken after the filters and before the
   * slice, which is the only number a pager can trust.
   */
  async listWithTotal(options?: {
    domain?: string;
    type?: NeuronType;
    min_heat?: number;
    limit?: number;
    offset?: number;
  }): Promise<{ total: number; rows: Awaited<ReturnType<Cortex['list']>>; unreadable: UnreadableNeuron[] }> {
    const unreadable: UnreadableNeuron[] = [];
    const all = await this.list({ ...options, limit: Number.MAX_SAFE_INTEGER, offset: 0 }, unreadable);
    const limit = options?.limit || 50;
    const offset = Math.max(0, options?.offset || 0);
    return { total: all.length, rows: all.slice(offset, offset + limit), unreadable };
  }

  /**
   * List all neurons with optional filters.
   */
  async list(options?: {
    domain?: string;
    type?: NeuronType;
    min_heat?: number;
    limit?: number;
    /** Rows to skip after the heat sort, for paging. Default 0. */
    offset?: number;
  }, unreadable?: UnreadableNeuron[]): Promise<Array<{
    id: string;
    name: string;
    domain: string;
    type: NeuronType;
    heat: number;
    last_accessed: string;
    facts_count: number;
  }>> {
    const ids = await listJSONFiles(this.brain.paths.cortex);
    const neurons: Array<{
      id: string;
      name: string;
      domain: string;
      type: NeuronType;
      heat: number;
      last_accessed: string;
      facts_count: number;
    }> = [];

    const calor = await this.heatMap();
    for (const id of ids) {
      let neuron: Neuron | null;
      try {
        neuron = await readJSON<Neuron>(this.brain.paths.neuron(id));
      } catch (err) {
        // One unreadable file is listed apart, never the end of the listing.
        const info = await this.noteUnreadable(id, err);
        unreadable?.push(info);
        continue;
      }
      if (!neuron) continue;
      const heat = calor.get(neuron.id) ?? neuron.heat;

      // Apply filters
      if (options?.domain && neuron.domain !== options.domain) continue;
      if (options?.type && neuron.type !== options.type) continue;
      if (options?.min_heat && heat < options.min_heat) continue;

      neurons.push({
        id: neuron.id,
        name: neuron.name,
        domain: neuron.domain,
        type: neuron.type,
        heat,
        last_accessed: neuron.last_accessed,
        facts_count: (neuron.facts || []).length,
      });
    }

    // Sort by heat (descending)
    neurons.sort((a, b) => b.heat - a.heat);

    // Apply offset, then limit
    const limit = options?.limit || 50;
    const offset = Math.max(0, options?.offset || 0);
    return neurons.slice(offset, offset + limit);
  }

  /**
   * Update a neuron's summary.
   */
  async updateSummary(id: string, summary: string): Promise<Neuron | null> {
    const neuron = await this.updateNeuron(id, current => {
      if (!current) return null;
      current.summary = summary;
      current.last_accessed = now();
      return current;
    });
    if (!neuron) return null;
    await this.reindex(neuron);
    return neuron;
  }

  /**
   * Add tags to a neuron.
   */
  async addTags(id: string, tags: string[]): Promise<Neuron | null> {
    const neuron = await this.updateNeuron(id, current => {
      if (!current) return null;
      for (const tag of tags) {
        if (!current.tags.includes(tag)) current.tags.push(tag);
      }
      return current;
    });
    if (!neuron) return null;
    await this.reindex(neuron);
    return neuron;
  }

  /**
   * Remove facts for good.
   *
   * The only destructive operation in CRBRO, so it never edits in place: the
   * whole neuron is copied to .quarantine/ first, with a timestamp, and can be
   * put back by hand. Superseding hides a fact; this is for the ones that must
   * not exist at all — a credential, someone's personal data.
   */
  async forget(
    neuronRef: string,
    targets: string[]
  ): Promise<{ neuron_id: string | null; removed: number; backup: string | null }> {
    const found = await this.resolveForWrite(neuronRef);
    if (!found) return { neuron_id: null, removed: 0, backup: null };

    let backup: string | null = null;
    let removed = 0;
    const wanted = targets.map(t => t.trim().toLowerCase());
    // An entry goes when a target names its text or its id: the entryId the
    // neuron index and recall show, or a decision's own id. Until 2.9.1 only
    // facts matched by id, so taking a credential out of a preference meant
    // pasting the credential back into the conversation to name it.
    const matches = (text: string | undefined, ownId?: string): boolean => {
      const t = (text || '').trim().toLowerCase();
      if (!t) return false;
      return wanted.includes(t) || wanted.includes(entryId(text!).toLowerCase())
        || (!!ownId && wanted.includes(ownId.toLowerCase()));
    };
    const factMatches = (f: Fact) => {
      const fid = (f.id || factId(f.text)).toLowerCase();
      return wanted.includes(fid) || wanted.includes(f.text.trim().toLowerCase());
    };
    // What left, read inside the lock: the quarantine copy and the emitted
    // removals describe exactly what this call took out, not a snapshot read
    // before somebody else wrote.
    let quitado: QuarantineEntries | null = null;

    const after = await this.updateNeuron(found.id, async current => {
      if (!current) return null;
      const q: QuarantineEntries = {
        quarantine_format: 2, kind: 'entries',
        neuron_id: current.id, name: current.name, type: current.type, domain: current.domain, taken_at: now(),
        facts: (current.facts || []).filter(factMatches).map(copyFact),
        decisions: (current.decisions || []).filter(d => matches(d.text, d.id)).map(d => ({ ...d })),
        patterns: (current.patterns || []).filter(p => matches(p)),
        preferences: (current.preferences || []).filter(p => matches(p)),
        errors: (current.errors || []).filter(e => matches(e)),
        debts: (current.debts || []).filter(d => matches(d)),
        ...(current.map && wanted.includes(current.map.text.trim().toLowerCase()) ? { map: { ...current.map } } : {}),
      };
      removed = q.facts.length + q.decisions.length + q.patterns.length + q.preferences.length
        + q.errors.length + q.debts.length + (q.map ? 1 : 0);
      // Nothing matched: nothing is written, and no copy is kept either.
      if (removed === 0) return null;

      // The sidecars of what leaves travel with it, so restore puts each entry
      // back with its date, retirement, provenance and check.
      const llaves = new Set([...q.decisions.map(d => d.text), ...q.patterns, ...q.preferences, ...q.errors, ...q.debts].map(entryId));
      const parte = <T>(rec: Record<string, T> | undefined): Record<string, T> | undefined => {
        if (!rec) return undefined;
        const out: Record<string, T> = {};
        for (const k of Object.keys(rec)) if (llaves.has(k)) out[k] = rec[k];
        return Object.keys(out).length ? out : undefined;
      };
      const fechas = parte(current.entry_dates); if (fechas) q.entry_dates = fechas;
      const estados = parte(current.entry_status); if (estados) q.entry_status = estados;
      const origenes = parte(current.entry_source); if (origenes) q.entry_source = origenes;
      const verificadas = parte(current.entry_verified); if (verificadas) q.entry_verified = verificadas;
      const evidencias = parte(current.entry_verification); if (evidencias) q.entry_verification = evidencias;

      // The copy first, inside the lock: if it cannot be written (a full disk,
      // encryption on without its key) nothing is removed.
      backup = await writeQuarantine(this.brain.paths.quarantine, current.id, q, 'entries');
      quitado = q;

      // Dated entries before the removal, so their dates can go with them.
      const fechadasAntes = [
        ...current.patterns, ...current.preferences,
        ...(current.errors || []), ...(current.debts || []),
      ];

      current.facts = current.facts.filter(f => !factMatches(f));
      // Decisions, patterns and preferences too. A credential is no less
      // exposed for sitting in one of those, and nothing else could remove it.
      current.decisions = current.decisions.filter(d => !matches(d.text, d.id));
      current.patterns = current.patterns.filter(p => !matches(p));
      current.preferences = current.preferences.filter(p => !matches(p));
      if (current.errors) {
        current.errors = current.errors.filter(e => !matches(e));
      }
      if (current.debts) {
        current.debts = current.debts.filter(d => !matches(d));
      }
      if (q.map) delete current.map;

      // Drop the dates of what left, so the sidecar never outlives its entry.
      if (current.entry_dates) {
        const quedan = new Set([
          ...current.patterns, ...current.preferences,
          ...(current.errors || []), ...(current.debts || []),
        ].map(entryId));
        for (const t of fechadasAntes) {
          const k = entryId(t);
          if (!quedan.has(k)) delete current.entry_dates[k];
        }
      }
      // Same for retirements: a key whose entry is gone is pruned, so the
      // sidecar cannot hide a line that no longer exists.
      if (current.entry_status) {
        const vivos = liveEntryKeys(current);
        for (const k of Object.keys(current.entry_status)) {
          if (!vivos.has(k)) delete current.entry_status[k];
        }
        if (Object.keys(current.entry_status).length === 0) delete current.entry_status;
      }
      // Verifications go with their entry too.
      if (current.entry_verified) {
        const vivos = liveEntryKeys(current);
        for (const k of Object.keys(current.entry_verified)) {
          if (!vivos.has(k)) delete current.entry_verified[k];
        }
        if (Object.keys(current.entry_verified).length === 0) delete current.entry_verified;
      }
      if (current.entry_verification) {
        const vivos = liveEntryKeys(current);
        for (const k of Object.keys(current.entry_verification)) {
          if (!vivos.has(k)) delete current.entry_verification[k];
        }
        if (Object.keys(current.entry_verification).length === 0) delete current.entry_verification;
      }
      // And for provenance: a forgotten teammate line that comes back through
      // a sync replay must be labelled by that replay, not by a stale key.
      if (current.entry_source) {
        const vivos = liveEntryKeys(current);
        for (const k of Object.keys(current.entry_source)) {
          if (!vivos.has(k)) delete current.entry_source[k];
        }
        if (Object.keys(current.entry_source).length === 0) delete current.entry_source;
      }
      current.last_accessed = now();
      return current;
    });

    const q = quitado as QuarantineEntries | null;
    if (removed > 0 && after && q) {
      await this.reindex(after);
      // The removal must travel, or the next sync resurrects from the team
      // log exactly what the user asked to destroy. Facts retract (status
      // only moves forward, so a stale copy cannot revive them); errors get
      // a purge op keyed by content hash; a cleared map emits the empty-map
      // tombstone that wins the LWW. The emitter no-ops on unshared neurons.
      const cuando = now();
      for (const f of q.facts) {
        await this.emit(found.id, { kind: 'status', fid: f.id || factId(f.text), to: 'retracted', at: cuando, why: 'forgotten' });
      }
      for (const d of q.decisions) {
        await this.emit(found.id, { kind: 'decision_purge', key: entryId(d.text), at: cuando });
      }
      for (const p of q.patterns) {
        await this.emit(found.id, { kind: 'pattern_purge', key: entryId(p), at: cuando });
      }
      for (const e of q.errors) {
        await this.emit(found.id, { kind: 'error_purge', key: entryId(e), at: cuando });
      }
      for (const d of q.debts) {
        await this.emit(found.id, { kind: 'debt_purge', key: entryId(d), at: cuando });
      }
      if (q.map) {
        await this.emit(found.id, { kind: 'map', text: '', at: cuando });
      }
    }
    return { neuron_id: found.id, removed, backup: removed > 0 ? backup : null };
  }

  /**
   * Delete a whole neuron. Quarantine copy first, then the file goes, the
   * index drops its chunks and the manifest is decremented.
   *
   * Synapses are not touched here (the Cortex has no Synapses): the server
   * calls synapses.removeAllFor(id) right after. Nor is shared state checked
   * — the server refuses beforehand when the neuron is shared, because the
   * next sync would simply re-create it from the team log. Nothing is
   * emitted: there is no neuron-delete op.
   */
  async forgetNeuron(neuronRef: string): Promise<{
    neuron_id: string | null;
    backup: string | null;
    counts: { facts: number; decisions: number; patterns: number; preferences: number; errors: number; debts: number; connections: number };
  }> {
    const vacio = { facts: 0, decisions: 0, patterns: 0, preferences: 0, errors: 0, debts: 0, connections: 0 };
    const found = await this.resolveForWrite(neuronRef);
    if (!found) return { neuron_id: null, backup: null, counts: vacio };

    // Copy and delete under the neuron's lock (2.11): a learn landing between
    // the copy and the unlink used to be deleted without being in the copy.
    const r = await this.quarantineAndDelete(found.id);
    if (!r) return { neuron_id: null, backup: null, counts: vacio };
    const n = r.neuron;
    return {
      neuron_id: n.id,
      backup: r.backup,
      counts: {
        facts: (n.facts || []).length,
        decisions: (n.decisions || []).length,
        patterns: (n.patterns || []).length,
        preferences: (n.preferences || []).length,
        errors: (n.errors || []).length,
        debts: (n.debts || []).length,
        connections: (n.connections || []).length,
      },
    };
  }

  /**
   * Under the neuron's lock: read it as it is now, copy it whole to
   * quarantine, delete the file. Null when it is already gone. If the copy
   * cannot be written (encryption on without its key, a full disk) nothing is
   * deleted. Index and manifest follow outside the lock.
   */
  private async quarantineAndDelete(id: string): Promise<{ neuron: Neuron; backup: string } | null> {
    const file = this.brain.paths.neuron(id);
    const r = await withLock(file, async () => {
      const current = await this.readStrict(id);
      if (!current) return null;
      const backup = await this.quarantine(current);
      await deleteJSON(file);
      return { neuron: current, backup };
    });
    if (!r) return null;
    await this.unindex(id);
    const manifest = await this.brain.getManifest();
    await this.brain.updateManifest({ total_neurons: Math.max(0, manifest.total_neurons - 1) });
    return r;
  }

  /**
   * Quarantine copies of one neuron, newest first: whole copies and copies of
   * forgotten entries, clear or sealed. Stamps sort lexically, so the file
   * name alone orders them; `base` is what restore's `file` option takes.
   */
  private async quarantineCopies(neuronId: string): Promise<Array<{ base: string; file: string }>> {
    return (await listQuarantine(this.brain.paths.quarantine, neuronId)).map(c => ({ base: c.base, file: c.file }));
  }

  /**
   * Bring a neuron back from quarantine.
   *
   * The newest copy is used unless `file` names an exact basename. If the
   * neuron no longer exists the copy is written back as it was; if it does
   * (a forget of facts, or the topic was re-created since) the copy is
   * unioned into it. The quarantine file stays where it is, so a restore is
   * repeatable. Nothing is emitted.
   *
   * A copy of forgotten entries (2.11) holds those entries and their
   * sidecars, not the neuron: unioned into the neuron when it exists, or
   * written as a neuron of its own name, type and domain when it does not.
   * Sealed copies are opened with the at-rest key.
   */
  async restoreNeuron(neuronId: string, options?: { file?: string }): Promise<{
    neuron: Neuron | null;
    restored_from: string | null;
    merged_into_existing: boolean;
    moved: ReturnType<typeof unionNeuron>['moved'] | null;
  }> {
    const nada = { neuron: null, restored_from: null, merged_into_existing: false, moved: null };
    const copias = await this.quarantineCopies(neuronId);
    let elegida: { base: string; file: string } | undefined;
    if (options?.file) {
      const pedido = options.file.replace(/\.json(\.enc)?$/i, '');
      elegida = copias.find(c => c.base === pedido);
    } else {
      elegida = copias[0];
    }
    if (!elegida) return nada;

    const ruta = path.join(this.brain.paths.quarantine, elegida.file);
    const leida = await readQuarantine<unknown>(ruta);
    let copia: Neuron | null = null;
    if (isEntriesCopy(leida)) copia = entriesAsNeuron(leida);
    else if (leida && typeof leida === 'object' && (leida as Neuron).id) copia = leida as Neuron;
    if (!copia) return nada;
    copia.id = neuronId;

    // Decide inside the lock, like create: whether the neuron exists again is
    // only known for sure while nobody else can write it.
    let escrita = false;
    let moved: ReturnType<typeof unionNeuron>['moved'] | null = null;
    const saved = await this.updateNeuron(neuronId, current => {
      if (!current) {
        escrita = true;
        return copia;
      }
      const r = unionNeuron(current, copia!);
      moved = r.moved;
      return r.neuron;
    });
    const final = (saved || copia) as Neuron;
    if (escrita) {
      const manifest = await this.brain.getManifest();
      await this.brain.updateManifest({ total_neurons: manifest.total_neurons + 1 });
    }
    await this.reindex(final);
    return { neuron: final, restored_from: ruta, merged_into_existing: !escrita, moved };
  }

  /**
   * Fold one neuron into another and delete the first.
   *
   * `from` is quarantined, unioned into `into`, and then removed exactly like
   * forgetNeuron. Each element that actually moved is emitted for `into`, so
   * a shared target receives the knowledge (the emitter no-ops when `into`
   * is unshared). Synapses are not touched — the server calls
   * synapses.rewire(from, into) right after — and the server refuses
   * beforehand when `from` is shared (unshare first, or the next sync
   * re-creates it).
   */
  async mergeNeurons(fromRef: string, intoRef: string): Promise<{
    from: string | null;
    into: string | null;
    backup: string | null;
    moved: ReturnType<typeof unionNeuron>['moved'] | null;
  }> {
    const from = await this.resolveForWrite(fromRef);
    const into = await this.resolveForWrite(intoRef);
    if (!from || !into || from.id === into.id) {
      return { from: from?.id ?? null, into: into?.id ?? null, backup: null, moved: null };
    }

    // Under the source's lock (2.11): what is copied, unioned and deleted is
    // the source as it is at that moment, so a learn into it meanwhile is
    // either in all three or waits and then finds it gone.
    let antes: Neuron = into;
    let moved: ReturnType<typeof unionNeuron>['moved'] | null = null;
    let intoGone = false;
    const hecho = await withLock(this.brain.paths.neuron(from.id), async () => {
      const fuente = await this.readStrict(from.id);
      if (!fuente) return null;
      const backup = await this.quarantine(fuente);
      const saved = await this.updateNeuron(into.id, current => {
        if (!current) { intoGone = true; return null; }
        antes = current;
        const r = unionNeuron(current, fuente);
        moved = r.moved;
        return r.neuron;
      });
      if (!saved || intoGone) return { backup, final: null };
      await deleteJSON(this.brain.paths.neuron(from.id));
      return { backup, final: saved };
    });
    if (!hecho) return { from: null, into: into.id, backup: null, moved: null };
    if (!hecho.final) throw this.deletedMeanwhile(into.id);
    const final = hecho.final;
    await this.reindex(final);
    await this.emitAdded(antes, final);

    await this.unindex(from.id);
    const manifest = await this.brain.getManifest();
    await this.brain.updateManifest({ total_neurons: Math.max(0, manifest.total_neurons - 1) });

    return { from: from.id, into: into.id, backup: hecho.backup, moved };
  }

  /**
   * Emit what a union added, by diffing the result against what the target
   * had. The union is pure, so this is exact: nothing the target already held
   * is re-announced. The emitter no-ops when the target is not shared.
   */
  private async emitAdded(antes: Neuron, final: Neuron): Promise<void> {
    const cuando = now();
    const teniaFact = new Map(antes.facts.map(f => [f.id || factId(f.text), f]));
    for (const f of final.facts) {
      const fid = f.id || factId(f.text);
      const previo = teniaFact.get(fid) || antes.facts.find(p => normalizeText(p.text) === normalizeText(f.text));
      const metadata = (v: Fact) => JSON.stringify([v.keys, v.shelf_life, v.reference, v.temporal, v.verification_invalidated_at]);
      if (!previo || metadata(previo) !== metadata(f)) {
        await this.emit(final.id, { kind: 'fact', text: f.text, fid, conf: f.confidence ?? 1, at: f.added, src: f.source, keys: f.keys,
          ...(f.reference ? { reference: f.reference } : {}), ...(f.temporal ? { temporal: f.temporal } : {}),
          ...(f.verification_invalidated_at ? { verification_invalidated_at: f.verification_invalidated_at } : {}),
          ...(f.shelf_life ? { shelf: f.shelf_life } : {}) });
      }
      if (f.verified && (previo?.verified !== f.verified || JSON.stringify(previo?.verification) !== JSON.stringify(f.verification))) {
        await this.emit(final.id, { kind: 'verify', eid: fid, ekind: 'fact', at: f.verified,
        ...(f.verification ? { verification: f.verification } : {}) });
      }
      // A moved fact that was already retired must arrive retired, or the
      // teammates would see as current what the source had superseded.
      if (previo?.status !== f.status && (f.status === 'superseded' || f.status === 'retracted')) {
        await this.emit(final.id, { kind: 'status', fid, to: f.status, at: f.revised || cuando, why: f.revision_note });
      }
    }
    const teniaDecision = new Set(antes.decisions.map(d => normalizeText(d.text)));
    for (const d of final.decisions) {
      if (teniaDecision.has(normalizeText(d.text))) continue;
      await this.emit(final.id, { kind: 'decision', text: d.text, why: d.rationale || undefined, at: d.date || cuando });
    }
    const fecha = (t: string) => final.entry_dates?.[entryId(t)] || cuando;
    const teniaPattern = new Set((antes.patterns || []).map(normalizeText));
    for (const p of final.patterns) {
      if (!teniaPattern.has(normalizeText(p))) await this.emit(final.id, { kind: 'pattern', text: p, at: fecha(p) });
    }
    const teniaError = new Set((antes.errors || []).map(normalizeText));
    for (const e of final.errors || []) {
      if (!teniaError.has(normalizeText(e))) await this.emit(final.id, { kind: 'error', text: e, at: fecha(e) });
    }
    const teniaDebt = new Set((antes.debts || []).map(normalizeText));
    for (const d of final.debts || []) {
      if (!teniaDebt.has(normalizeText(d))) await this.emit(final.id, { kind: 'debt', text: d, at: fecha(d) });
    }
    // Checks of decisions and patterns that arrived with them, or are newer than the target's.
    for (const [k, at] of Object.entries(final.entry_verified || {})) {
      if (antes.entry_verified?.[k] === at && JSON.stringify(antes.entry_verification?.[k]) === JSON.stringify(final.entry_verification?.[k])) continue;
      await this.emit(final.id, { kind: 'verify', eid: k, ekind: 'entry', at,
        ...(final.entry_verification?.[k] ? { verification: final.entry_verification[k] } : {}) });
    }
    // Preferences are never emitted, here as in learn.
  }

  /**
   * Move entries from one neuron to another, whole: text, date, keys,
   * confidence, retirement. The way to split a neuron that grew past what one
   * read can carry — learn + forget would do it too, but every entry would be
   * reborn today and lose the one thing recall uses to tell old from new.
   *
   * `targets` are entry ids (factId for facts, entryId for the rest) or exact
   * texts, any kind. The target neuron is created when missing, with the
   * source's type and domain. Order is union first, removal second: a crash
   * in between leaves an entry in both places, never in neither. The source
   * is quarantined by forget() before anything leaves it. The map never
   * moves: it describes the system, not an entry.
   */
  async moveEntries(fromRef: string, targets: string[], intoRef: string, options?: { domain?: string }): Promise<{
    from: string | null;
    into: string | null;
    created: boolean;
    moved: number;
    unmatched: string[];
    backup: string | null;
  }> {
    const from = await this.resolveForWrite(fromRef);
    if (!from) return { from: null, into: null, created: false, moved: 0, unmatched: targets, backup: null };

    const wanted = new Set(targets.map(t => t.trim().toLowerCase()).filter(Boolean));
    const usados = new Set<string>();
    const pide = (id: string, text: string) => {
      const a = id.toLowerCase(), b = text.trim().toLowerCase();
      if (wanted.has(a)) { usados.add(a); return true; }
      if (wanted.has(b)) { usados.add(b); return true; }
      return false;
    };
    const parte: Neuron = {
      ...from,
      facts: (from.facts || []).filter(f => pide(f.id || factId(f.text), f.text)).map(copyFact),
      decisions: (from.decisions || []).filter(d => pide(d.id || entryId(d.text), d.text)).map(d => ({ ...d })),
      patterns: (from.patterns || []).filter(t => pide(entryId(t), t)),
      preferences: (from.preferences || []).filter(t => pide(entryId(t), t)),
      errors: (from.errors || []).filter(t => pide(entryId(t), t)),
      debts: (from.debts || []).filter(t => pide(entryId(t), t)),
      tags: [], connections: [], summary: '', heat: 0, access_count: 0,
      entry_dates: { ...(from.entry_dates || {}) },
      entry_status: { ...(from.entry_status || {}) },
      entry_verified: { ...(from.entry_verified || {}) },
      entry_verification: structuredClone(from.entry_verification || {}),
    };
    delete parte.map;
    const textos = [
      ...parte.facts.map(f => f.id || factId(f.text)),
      ...parte.decisions.map(d => d.text), ...parte.patterns, ...parte.preferences,
      ...(parte.errors || []), ...(parte.debts || []),
    ];
    const unmatched = targets.filter(t => !usados.has(t.trim().toLowerCase()));
    if (textos.length === 0) return { from: from.id, into: null, created: false, moved: 0, unmatched, backup: null };

    let into = await this.resolveForWrite(intoRef);
    let created = false;
    if (!into) {
      into = await this.create(intoRef, from.type, options?.domain || from.domain);
      created = true;
    }
    if (into.id === from.id) return { from: from.id, into: into.id, created: false, moved: 0, unmatched, backup: null };

    let antes: Neuron = into;
    const saved = await this.updateNeuron(into.id, current => {
      antes = current || into!;
      return unionNeuron(antes, parte).neuron;
    });
    const final = (saved || into) as Neuron;
    await this.reindex(final);
    await this.emitAdded(antes, final);
    this.tally.topics.add(final.id);

    const r = await this.forget(from.id, textos);
    return { from: from.id, into: final.id, created, moved: r.removed, unmatched, backup: r.backup };
  }

  /**
   * Fold many small neurons into one digest neuron, in a single pass.
   *
   * mergeNeurons would do it one at a time, reindexing a growing target on
   * every call — quadratic, and minutes on the 766 leftovers this was written
   * for. Here every source is quarantined, the union is built in memory,
   * written once and indexed once; only then do the sources go. A source's
   * NAME is the only context a one-line neuron had ("Phase 1 homepage audit
   * francortes…"), so its words travel as the fact's keys: searchable, never
   * shown. The caller picks the sources; nothing here judges them. Unshared
   * and unconnected sources only — there is no rewiring in this path.
   */
  async compact(sourceIds: string[], digestName: string, options: { type: NeuronType; domain: string }): Promise<{
    into: string | null;
    folded: string[];
    skipped: string[];
    entries: number;
  }> {
    const sources: Neuron[] = [];
    const skipped: string[] = [];
    for (const id of sourceIds) {
      const n = await this.peek(id);
      if (!n || (n.connections || []).length > 0) { skipped.push(id); continue; }
      sources.push(n);
    }
    if (sources.length === 0) return { into: null, folded: [], skipped, entries: 0 };

    let target = await this.findByName(digestName);
    if (!target) {
      target = await this.create(digestName, options.type, options.domain);
      await this.addTags(target.id, ['digest']);
    }
    const targetId = target.id;
    for (const n of sources) await this.quarantine(n);

    const saved = await this.updateNeuron(targetId, current => {
      if (!current) return null;   // deleted meanwhile: never resurrect it (2.11)
      let acc = current;
      for (const n of sources) {
        if (n.id === targetId) continue;
        const pistas = normalizeKeys(n.name.split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 4).slice(0, 8));
        const conPistas: Neuron = {
          ...n,
          facts: (n.facts || []).map(f => ({ ...copyFact(f), keys: normalizeKeys([...(f.keys || []), ...pistas]) })),
          tags: [], summary: '',
        };
        acc = unionNeuron(acc, conPistas).neuron;
      }
      return acc;
    });
    if (!saved) throw this.deletedMeanwhile(targetId);
    const final = saved;
    await this.reindex(final);

    const folded: string[] = [];
    for (const n of sources) {
      if (n.id === targetId) continue;
      // Delete only the source as it was read: one written since keeps its
      // file (its old line is in the digest too — a duplicate, never a loss).
      const borrada = await withLock(this.brain.paths.neuron(n.id), async () => {
        let ahora: Neuron | null = null;
        try { ahora = await readJSON<Neuron>(this.brain.paths.neuron(n.id)); } catch { return false; }
        if (!ahora || JSON.stringify(ahora) !== JSON.stringify(n)) return false;
        await deleteJSON(this.brain.paths.neuron(n.id));
        return true;
      });
      if (!borrada) { skipped.push(n.id); continue; }
      await this.unindex(n.id);
      const manifest = await this.brain.getManifest();
      await this.brain.updateManifest({ total_neurons: Math.max(0, manifest.total_neurons - 1) });
      folded.push(n.id);
    }
    const entries = final.facts.length + final.decisions.length + final.patterns.length
      + final.preferences.length + (final.errors || []).length + (final.debts || []).length;
    return { into: targetId, folded, skipped, entries };
  }

  /**
   * Which neurons hold something that looks like a credential.
   * Reports the kind and where it is, never the value.
   */
  async auditSecrets(): Promise<Array<{
    neuron_id: string;
    name: string;
    kinds: string[];
    facts: number;
    decisions: number;
    patterns: number;
    preferences: number;
    errors: number;
    debts: number;
    map: number;
  }>> {
    const out: Array<{
      neuron_id: string; name: string; kinds: string[];
      facts: number; decisions: number; patterns: number; preferences: number;
      errors: number; debts: number; map: number;
    }> = [];

    for (const id of await listJSONFiles(this.brain.paths.cortex)) {
      const n = await this.peek(id);   // an unreadable file is skipped and listed in unreadable()
      if (!n) continue;

      const kinds = new Set<string>();
      const contar = (textos: Array<string | undefined>) => {
        let c = 0;
        for (const t of textos) {
          const k = secretKinds(t || '');
          if (k.length) {
            c++;
            k.forEach(x => kinds.add(x));
          }
        }
        return c;
      };

      // Every field, not just facts. A credential is just as exposed sitting in
      // a decision or a preference, and those were invisible here — an audit
      // could report a neuron clean while a key sat in preferences[0].
      const facts = contar((n.facts || []).map(f => f.text));
      const decisions = contar((n.decisions || []).map(d => d.text));
      const patterns = contar(n.patterns || []);
      const preferences = contar(n.preferences || []);
      const errors = contar(n.errors || []);
      const debts = contar(n.debts || []);
      const mapa = contar(n.map?.text ? [n.map.text] : []);

      if (facts + decisions + patterns + preferences + errors + debts + mapa > 0) {
        out.push({
          neuron_id: n.id, name: n.name, kinds: [...kinds],
          facts, decisions, patterns, preferences,
          errors, debts, map: mapa,
        });
      }
    }
    return out;
  }

  /**
   * Get all neuron IDs.
   */
  async allIds(): Promise<string[]> {
    return listJSONFiles(this.brain.paths.cortex);
  }

  /**
   * Count total neurons.
   */
  async count(): Promise<number> {
    const ids = await listJSONFiles(this.brain.paths.cortex);
    return ids.length;
  }
}
