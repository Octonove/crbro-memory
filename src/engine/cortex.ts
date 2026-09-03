// ─── CRBRO Cortex Engine ─────────────────────────────────────────
// Neuron CRUD — create, read, update, list neurons

import { readJSON, writeJSON, updateJSON, deleteJSON, listJSONFiles, now } from '../utils/fs.js';
import { neuronId, inferNeuronType, toSnakeCase, legacySnakeCase } from '../utils/ids.js';
import { factId } from '../utils/hash.js';
import { entryId, normalizeText } from '../sync/ops.js';
import { redact, secretKinds } from './secrets.js';
import type { Brain } from './brain.js';
import type { Neuron, NeuronType, Fact, Decision, FactStatus, EntryStatus, EntryRetirement } from '../types/index.js';

const TYPE_PREFIX_RE = /^(project_|tech_|lang_|person_|domain_|process_|protocol_)/;

/**
 * Similarity above which a new fact is flagged as a near-duplicate of one
 * already in the neuron. Warn-only, never merge: blind similarity is how
 * "sprint_2" and "sprint_3" become one thing. Below 60 characters the
 * bigram signal is noise, so short facts are left to the exact-dup check.
 */
const NEAR_DUP_THRESHOLD = 0.8;
const NEAR_DUP_MIN_LENGTH = 60;

/** Minimum similarity before we accept a near-miss as "the same topic". */
const NAME_MATCH_THRESHOLD = 0.85;

/**
 * Dice coefficient over character bigrams. Cheap, order-insensitive enough
 * for "Widget Catalog" vs "widget_catalog", and — unlike substring containment —
 * it does not consider a 60-character walkthrough id a match for "SEO".
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };

  const A = bigrams(a);
  const B = bigrams(b);
  let shared = 0;
  for (const [g, countA] of A) {
    const countB = B.get(g);
    if (countB) shared += Math.min(countA, countB);
  }
  return (2 * shared) / (a.length - 1 + b.length - 1);
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

export type Indexer = (neuron: Neuron) => Promise<void> | void;

/**
 * Called after a write so shared neurons can append a note to the team log.
 * A hook rather than a direct call, because the sync layer needs the Cortex
 * and the Cortex would then need the sync layer.
 */
export type Emitter = (
  neuronId: string,
  change:
    | { kind: 'fact'; text: string; fid: string; conf: number; at: string; src?: string; keys?: string[] }
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
    const keys = normalizeKeys([...(hit.keys || []), ...(sf.keys || [])]);
    if (keys.length) hit.keys = keys; else delete hit.keys;
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

  /** What this session has actually written, for an honest consolidate(). */
  private tally = { facts: 0, decisions: 0, topics: new Set<string>() };

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
    this.tally = { facts: 0, decisions: 0, topics: new Set<string>() };
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
   * newest copy by name alone.
   */
  private async quarantine(neuron: Neuron): Promise<string> {
    const sello = now().replace(/[:.]/g, '-');
    const backup = `${this.brain.paths.quarantine}/${neuron.id}.${sello}.json`;
    await writeJSON(backup, neuron);
    return backup;
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
      // Sharing must never break a local write. The note can be re-emitted
      // later; a lost fact cannot be recovered.
    }
  }

  /**
   * Overwrite a neuron with the result of merging the team's notes.
   * Only the sync layer calls this, and only with a neuron that already
   * contains everything local plus whatever arrived.
   */
  async replaceFromSync(neuron: Neuron): Promise<Neuron> {
    const saved = await updateJSON<Neuron>(this.brain.paths.neuron(neuron.id), current => {
      // Local-only observations stay local: they describe this machine's use
      // of the memory, not the knowledge itself.
      if (current) {
        neuron.heat = current.heat;
        neuron.access_count = current.access_count;
        neuron.last_accessed = current.last_accessed;
        neuron.summary = current.summary || neuron.summary;
        neuron.preferences = current.preferences;
        neuron.connections = current.connections;
        neuron.created = current.created;
      }
      return neuron;
    });
    const final = (saved || neuron) as Neuron;
    await this.reindex(final);
    return final;
  }

  private async reindex(neuron: Neuron): Promise<void> {
    if (!this.indexer) return;
    try {
      await this.indexer(neuron);
    } catch {
      // Indexing must never break a write. The index is derived data.
    }
  }

  /**
   * Get a neuron by ID.
   */
  async get(id: string): Promise<Neuron | null> {
    // Even a read touches the file (access time and count), so it goes through
    // the same locked read-modify-write as everything else.
    return updateJSON<Neuron>(this.brain.paths.neuron(id), current => {
      if (!current) return null;
      current.last_accessed = now();
      current.access_count = (current.access_count || 0) + 1;
      return current;
    });
  }

  /**
   * Get a neuron by ID without updating access stats.
   */
  async peek(id: string): Promise<Neuron | null> {
    return readJSON<Neuron>(this.brain.paths.neuron(id));
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
  async findByName(name: string): Promise<Neuron | null> {
    const ids = await listJSONFiles(this.brain.paths.cortex);
    const slug = toSnakeCase(name);
    if (!slug) return null;

    // Neurons created before accents were folded live under a mangled name
    // ("bsqueda" for "búsqueda"). Try the correct slug first, then that one,
    // so upgrading does not orphan them.
    const legacy = legacySnakeCase(name);
    const candidatos = legacy && legacy !== slug ? [slug, legacy] : [slug];

    // 1. Exact: the id itself, or the id minus its type prefix.
    for (const buscado of candidatos) {
      for (const id of ids) {
        if (id === buscado || id.replace(TYPE_PREFIX_RE, '') === buscado) {
          return this.peek(id);
        }
      }
    }

    // 2. Near-miss, but only a real one. Ties go to the most used neuron.
    const candidates: Array<{ id: string; score: number }> = [];
    for (const id of ids) {
      const bare = id.replace(TYPE_PREFIX_RE, '');
      const score = similarity(slug, bare);
      if (score >= NAME_MATCH_THRESHOLD && sameNumbers(slug, bare)) {
        candidates.push({ id, score });
      }
    }
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.score - a.score);
    const top = candidates[0].score;
    const tied = candidates.filter(c => c.score >= top - 0.001);
    if (tied.length === 1) return this.peek(tied[0].id);

    let best: Neuron | null = null;
    for (const c of tied) {
      const n = await this.peek(c.id);
      if (!n) continue;
      if (!best || (n.access_count || 0) > (best.access_count || 0)) best = n;
    }
    return best;
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
    const neuron = await updateJSON<Neuron>(this.brain.paths.neuron(id), current => {
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
      /** Ids or verbatim texts of facts this one replaces. */
      supersedes?: string[];
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
  }> {
    // Credentials never make it to disk. The sentence around them survives, so
    // "the deploy token is [REDACTED: npm token]" still records that a token
    // exists and what kind — the knowledge without the liability.
    const limpio = redact(content);
    content = limpio.text;

    let neuron: Neuron | null = null;
    let action: 'created' | 'updated' | 'skipped' | 'skipped_retired' = 'updated';

    if (options?.neuronId) {
      neuron = await this.peek(options.neuronId);
    }
    if (!neuron) {
      neuron = await this.findByName(topic);
    }

    if (!neuron) {
      if (options?.createIfMissing === false) {
        return {
          neuron: null, action: 'skipped', superseded: 0,
          supersedes_unmatched: options?.supersedes || [], near_duplicates: [], redacted: limpio.found,
          duplicate: false, updated_in_place: false, skipped_retired: null,
        };
      }
      const nType = options?.neuronType || inferNeuronType(topic);
      const domain = options?.domain || 'general';
      neuron = await this.create(topic, nType, domain);
      action = 'created';
    }

    let superseded = 0;
    // Stays empty unless retire() actually runs: a duplicate fact skips the
    // whole block, and warning "still live" about targets nobody touched is
    // a false alarm on every idempotent retry.
    let supersedesUnmatched: string[] = [];
    let nearDuplicates: Array<{ id: string; similarity: number; preview: string }> = [];
    let emitir: Parameters<Emitter>[1] | null = null;
    let duplicate = false;
    let updatedInPlace = false;
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

    const actualizada = await updateJSON<Neuron>(
      this.brain.paths.neuron(neuron.id),
      current => {
        const n = current || neuron;

        switch (type) {
          case 'fact': {
            const id = factId(content);
            const keys = normalizeKeys(options?.keys);
            const existente = n.facts.find(
              f => f.text.toLowerCase() === content.toLowerCase()
            );
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
              let cambiado = false;
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
              if (cambiado) {
                // Note for shared neurons: materialize takes max(conf) and
                // unions keys, so lowering confidence or dropping an alias
                // stays local. Documented, not fought — the log is append-only.
                updatedInPlace = true;
                this.tally.topics.add(n.id);
                emitir = { kind: 'fact' as const, text: existente.text, fid: existente.id || id,
                           conf: existente.confidence ?? 1, at: existente.added, src: existente.source, keys: existente.keys };
              }
            }
            if (!isDuplicate) {
              if (options?.supersedes?.length) {
                const retirado = this.retire(n, options.supersedes, id, 'superseded');
                superseded = retirado.count;
                supersedesUnmatched = retirado.unmatched;
              }
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
              n.facts.push(fact);
              this.tally.facts++;
              this.tally.topics.add(n.id);
              emitir = { kind: 'fact' as const, text: content, fid: id,
                         conf: fact.confidence, at: fact.added, src: fact.source, keys: fact.keys };
            }
            break;
          }
          case 'decision': {
            if (retirada(n, content)) return null;
            const decision: Decision = {
              text: content,
              date: now(),
              rationale: options?.rationale || '',
            };
            n.decisions.push(decision);
            this.tally.decisions++;
            this.tally.topics.add(n.id);
            emitir = { kind: 'decision' as const, text: content,
                       why: options?.rationale, at: decision.date };
            break;
          }
          case 'pattern': {
            if (retirada(n, content)) return null;
            if (!n.patterns.includes(content)) {
              n.patterns.push(content);
              fechar(n, content);
              emitir = { kind: 'pattern' as const, text: content, at: now() };
            }
            break;
          }
          case 'preference': {
            if (!n.preferences.includes(content)) {
              n.preferences.push(content);
              fechar(n, content);
            }
            break;
          }
          case 'error': {
            if (retirada(n, content)) return null;
            if (!n.errors) n.errors = [];
            if (!n.errors.includes(content)) {
              n.errors.push(content);
              fechar(n, content);
              this.tally.topics.add(n.id);
              emitir = { kind: 'error' as const, text: content, at: now() };
            }
            break;
          }
          case 'debt': {
            if (retirada(n, content)) return null;
            if (!n.debts) n.debts = [];
            if (!n.debts.includes(content)) {
              n.debts.push(content);
              fechar(n, content);
              this.tally.topics.add(n.id);
              emitir = { kind: 'debt' as const, text: content, at: now() };
            }
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

    const final = (actualizada || neuron) as Neuron;
    if (skippedRetired) {
      // Nothing was written, so nothing to index, emit or tally.
      return {
        neuron: final, action: 'skipped_retired', superseded: 0, supersedes_unmatched: [],
        near_duplicates: [], redacted: limpio.found,
        duplicate: false, updated_in_place: false, skipped_retired: skippedRetired,
      };
    }
    await this.reindex(final);
    // Preferences are never emitted: they are the field most likely to hold a
    // key and the least likely to be worth sharing.
    if (emitir) await this.emit(final.id, emitir);
    return {
      neuron: final, action, superseded, supersedes_unmatched: supersedesUnmatched,
      near_duplicates: nearDuplicates, redacted: limpio.found,
      duplicate, updated_in_place: updatedInPlace, skipped_retired: null,
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
      (await this.peek(neuronRef)) || (await this.findByName(neuronRef));
    if (!neuron) return { neuron: null, revised: 0, unmatched: targets.slice() };

    const status: FactStatus = options?.status || 'superseded';
    let revised = 0;
    let unmatched: string[] = targets.slice();
    const actualizada = await updateJSON<Neuron>(
      this.brain.paths.neuron(neuron.id),
      current => {
        const n = current || neuron;
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
    if (content.length < NEAR_DUP_MIN_LENGTH) return [];
    const nuevo = content.toLowerCase();
    const out: Array<{ id: string; similarity: number; preview: string }> = [];

    for (const fact of neuron.facts) {
      if (fact.status === 'superseded' || fact.status === 'retracted') continue;
      if (!fact.text || fact.text.length < NEAR_DUP_MIN_LENGTH) continue;
      if (fact.text === content) continue;   // the new fact itself, already pushed

      const score = similarity(nuevo, fact.text.toLowerCase());
      if (score >= NEAR_DUP_THRESHOLD) {
        out.push({
          id: fact.id || factId(fact.text),
          similarity: Math.round(score * 100) / 100,
          preview: fact.text.slice(0, 120),
        });
      }
    }

    out.sort((a, b) => b.similarity - a.similarity);
    return out.slice(0, 5);
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
  ): { count: number; unmatched: string[] } {
    let count = 0;
    const wanted = targets.map(t => t.trim().toLowerCase());
    const hit = new Set<number>();

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
    }

    return { count, unmatched: targets.filter((_, i) => !hit.has(i)) };
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
      (await this.peek(neuronRef)) || (await this.findByName(neuronRef));
    if (!neuron) return { neuron: null, revised: 0, unmatched: targets.slice() };

    const status: FactStatus = options?.status || 'superseded';
    const wanted = targets.map(t => normalizeText(t).toLowerCase());
    let revised = 0;
    let unmatched: string[] = targets.slice();

    const actualizada = await updateJSON<Neuron>(
      this.brain.paths.neuron(neuron.id),
      current => {
        const n = current || neuron;
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
      (await this.peek(neuronRef)) || (await this.findByName(neuronRef));
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
    const actualizada = await updateJSON<Neuron>(
      this.brain.paths.neuron(neuron.id),
      current => {
        const n = current || neuron;
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
    let neuron = (await this.peek(neuronRef)) || (await this.findByName(neuronRef));
    let action: 'created' | 'updated' = 'updated';
    if (!neuron) {
      const nType = options?.neuronType || inferNeuronType(neuronRef);
      neuron = await this.create(neuronRef, nType, options?.domain || 'general');
      action = 'created';
    }

    const cuando = now();
    const vaciar = content.trim() === '';
    const actualizada = await updateJSON<Neuron>(
      this.brain.paths.neuron(neuron.id),
      current => {
        const n = current || neuron!;
        // An empty map is not a map: writing '' clears it outright, so the
        // reader never meets a document that exists but says nothing.
        if (vaciar) delete n.map;
        else n.map = { text: content, updated: cuando };
        n.last_accessed = cuando;
        n.access_count = (n.access_count || 0) + 1;
        return n;
      }
    );

    const final = (actualizada || neuron) as Neuron;
    await this.reindex(final);
    // Clearing emits too: an empty map op is the tombstone that wins the LWW
    // on every machine, so a stale copy cannot resurrect the cleared map.
    await this.emit(final.id, { kind: 'map', text: vaciar ? '' : content, at: cuando });
    return { neuron: final, action, redacted: limpio.found };
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
  }): Promise<Array<{
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

    for (const id of ids) {
      const neuron = await readJSON<Neuron>(this.brain.paths.neuron(id));
      if (!neuron) continue;

      // Apply filters
      if (options?.domain && neuron.domain !== options.domain) continue;
      if (options?.type && neuron.type !== options.type) continue;
      if (options?.min_heat && neuron.heat < options.min_heat) continue;

      neurons.push({
        id: neuron.id,
        name: neuron.name,
        domain: neuron.domain,
        type: neuron.type,
        heat: neuron.heat,
        last_accessed: neuron.last_accessed,
        facts_count: neuron.facts.length,
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
    const neuron = await updateJSON<Neuron>(this.brain.paths.neuron(id), current => {
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
    const neuron = await updateJSON<Neuron>(this.brain.paths.neuron(id), current => {
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
    const found = (await this.peek(neuronRef)) || (await this.findByName(neuronRef));
    if (!found) return { neuron_id: null, removed: 0, backup: null };

    const backup = await this.quarantine(found);

    let removed = 0;
    const wanted = targets.map(t => t.trim().toLowerCase());

    const after = await updateJSON<Neuron>(this.brain.paths.neuron(found.id), current => {
      if (!current) return null;
      const antes =
        current.facts.length + current.decisions.length +
        current.patterns.length + current.preferences.length;
      // Dated entries before the removal, so their dates can go with them.
      const fechadasAntes = [
        ...current.patterns, ...current.preferences,
        ...(current.errors || []), ...(current.debts || []),
      ];

      current.facts = current.facts.filter(f => {
        const fid = (f.id || factId(f.text)).toLowerCase();
        return !(wanted.includes(fid) || wanted.includes(f.text.trim().toLowerCase()));
      });
      // Decisions, patterns and preferences too. A credential is no less
      // exposed for sitting in one of those, and nothing else could remove it.
      current.decisions = current.decisions.filter(
        d => !wanted.includes((d.text || '').trim().toLowerCase())
      );
      current.patterns = current.patterns.filter(
        p => !wanted.includes((p || '').trim().toLowerCase())
      );
      current.preferences = current.preferences.filter(
        p => !wanted.includes((p || '').trim().toLowerCase())
      );
      const erroresAntes = (current.errors || []).length;
      if (current.errors) {
        current.errors = current.errors.filter(
          e => !wanted.includes((e || '').trim().toLowerCase())
        );
      }
      const deudasAntes = (current.debts || []).length;
      if (current.debts) {
        current.debts = current.debts.filter(
          d => !wanted.includes((d || '').trim().toLowerCase())
        );
      }
      let mapaBorrado = 0;
      if (current.map && wanted.includes(current.map.text.trim().toLowerCase())) {
        delete current.map;
        mapaBorrado = 1;
      }

      removed = antes - (
        current.facts.length + current.decisions.length +
        current.patterns.length + current.preferences.length
      ) + (erroresAntes - (current.errors || []).length) + (deudasAntes - (current.debts || []).length) + mapaBorrado;
      if (removed === 0) return null;

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
      current.last_accessed = now();
      return current;
    });

    if (removed > 0 && after) {
      await this.reindex(after);
      // The removal must travel, or the next sync resurrects from the team
      // log exactly what the user asked to destroy. Facts retract (status
      // only moves forward, so a stale copy cannot revive them); errors get
      // a purge op keyed by content hash; a cleared map emits the empty-map
      // tombstone that wins the LWW. The emitter no-ops on unshared neurons.
      const cuando = now();
      for (const f of found.facts || []) {
        const fid = (f.id || factId(f.text)).toLowerCase();
        if (wanted.includes(fid) || wanted.includes(f.text.trim().toLowerCase())) {
          await this.emit(found.id, { kind: 'status', fid: f.id || factId(f.text), to: 'retracted', at: cuando, why: 'forgotten' });
        }
      }
      for (const d of found.decisions || []) {
        if (wanted.includes((d.text || '').trim().toLowerCase())) {
          await this.emit(found.id, { kind: 'decision_purge', key: entryId(d.text), at: cuando });
        }
      }
      for (const p of found.patterns || []) {
        if (wanted.includes((p || '').trim().toLowerCase())) {
          await this.emit(found.id, { kind: 'pattern_purge', key: entryId(p), at: cuando });
        }
      }
      for (const e of found.errors || []) {
        if (wanted.includes((e || '').trim().toLowerCase())) {
          await this.emit(found.id, { kind: 'error_purge', key: entryId(e), at: cuando });
        }
      }
      for (const d of found.debts || []) {
        if (wanted.includes((d || '').trim().toLowerCase())) {
          await this.emit(found.id, { kind: 'debt_purge', key: entryId(d), at: cuando });
        }
      }
      if (found.map && wanted.includes(found.map.text.trim().toLowerCase())) {
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
    const found = (await this.peek(neuronRef)) || (await this.findByName(neuronRef));
    if (!found) {
      return {
        neuron_id: null, backup: null,
        counts: { facts: 0, decisions: 0, patterns: 0, preferences: 0, errors: 0, debts: 0, connections: 0 },
      };
    }

    const backup = await this.quarantine(found);
    await this.deleteNeuronFile(found.id);

    return {
      neuron_id: found.id,
      backup,
      counts: {
        facts: (found.facts || []).length,
        decisions: (found.decisions || []).length,
        patterns: (found.patterns || []).length,
        preferences: (found.preferences || []).length,
        errors: (found.errors || []).length,
        debts: (found.debts || []).length,
        connections: (found.connections || []).length,
      },
    };
  }

  /**
   * Quarantine copies of one neuron, newest first. Stamps sort lexically, so
   * the file name alone orders them.
   */
  private async quarantineCopies(neuronId: string): Promise<string[]> {
    const prefijo = `${neuronId}.`;
    const files = await listJSONFiles(this.brain.paths.quarantine);
    return files.filter(f => f.startsWith(prefijo)).sort().reverse();
  }

  /**
   * Bring a neuron back from quarantine.
   *
   * The newest copy is used unless `file` names an exact basename. If the
   * neuron no longer exists the copy is written back as it was; if it does
   * (a forget of facts, or the topic was re-created since) the copy is
   * unioned into it. The quarantine file stays where it is, so a restore is
   * repeatable. Nothing is emitted.
   */
  async restoreNeuron(neuronId: string, options?: { file?: string }): Promise<{
    neuron: Neuron | null;
    restored_from: string | null;
    merged_into_existing: boolean;
    moved: ReturnType<typeof unionNeuron>['moved'] | null;
  }> {
    const nada = { neuron: null, restored_from: null, merged_into_existing: false, moved: null };
    let basename: string | null = null;
    if (options?.file) {
      const pedido = options.file.replace(/\.json$/i, '');
      const copias = await this.quarantineCopies(neuronId);
      basename = copias.includes(pedido) ? pedido : null;
    } else {
      basename = (await this.quarantineCopies(neuronId))[0] || null;
    }
    if (!basename) return nada;

    const ruta = `${this.brain.paths.quarantine}/${basename}.json`;
    const copia = await readJSON<Neuron>(ruta);
    if (!copia || !copia.id) return nada;
    copia.id = neuronId;

    // Decide inside the lock, like create: whether the neuron exists again is
    // only known for sure while nobody else can write it.
    let escrita = false;
    let moved: ReturnType<typeof unionNeuron>['moved'] | null = null;
    const saved = await updateJSON<Neuron>(this.brain.paths.neuron(neuronId), current => {
      if (!current) {
        escrita = true;
        return copia;
      }
      const r = unionNeuron(current, copia);
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
    const from = (await this.peek(fromRef)) || (await this.findByName(fromRef));
    const into = (await this.peek(intoRef)) || (await this.findByName(intoRef));
    if (!from || !into || from.id === into.id) {
      return { from: from?.id ?? null, into: into?.id ?? null, backup: null, moved: null };
    }

    const backup = await this.quarantine(from);

    let antes: Neuron = into;
    let moved: ReturnType<typeof unionNeuron>['moved'] | null = null;
    const saved = await updateJSON<Neuron>(this.brain.paths.neuron(into.id), current => {
      antes = current || into;
      const r = unionNeuron(antes, from);
      moved = r.moved;
      return r.neuron;
    });
    const final = (saved || into) as Neuron;
    await this.reindex(final);

    // Emit what moved, by diffing the result against what `into` had. The
    // union is pure, so this is exact: nothing the target already held is
    // re-announced.
    const cuando = now();
    const teniaFact = new Set(antes.facts.map(f => f.id || factId(f.text)));
    for (const f of final.facts) {
      const fid = f.id || factId(f.text);
      if (teniaFact.has(fid)) continue;
      await this.emit(final.id, { kind: 'fact', text: f.text, fid, conf: f.confidence ?? 1, at: f.added, src: f.source, keys: f.keys });
      // A moved fact that was already retired must arrive retired, or the
      // teammates would see as current what the source had superseded.
      if (f.status === 'superseded' || f.status === 'retracted') {
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
    // Preferences are never emitted, here as in learn.

    await this.deleteNeuronFile(from.id);

    return { from: from.id, into: into.id, backup, moved };
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
      const n = await readJSON<Neuron>(this.brain.paths.neuron(id));
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
