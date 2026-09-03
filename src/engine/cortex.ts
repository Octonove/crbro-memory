// ─── CRBRO Cortex Engine ─────────────────────────────────────────
// Neuron CRUD — create, read, update, list neurons

import { readJSON, writeJSON, updateJSON, listJSONFiles, now } from '../utils/fs.js';
import { neuronId, inferNeuronType, toSnakeCase, legacySnakeCase } from '../utils/ids.js';
import { factId } from '../utils/hash.js';
import { entryId } from '../sync/ops.js';
import { redact, secretKinds } from './secrets.js';
import type { Brain } from './brain.js';
import type { Neuron, NeuronType, Fact, Decision, FactStatus } from '../types/index.js';

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
    | { kind: 'fact'; text: string; fid: string; conf: number; at: string; src?: string }
    | { kind: 'status'; fid: string; to: 'superseded' | 'retracted'; at: string; why?: string }
    | { kind: 'decision'; text: string; why?: string; at: string }
    | { kind: 'pattern'; text: string; at: string }
    | { kind: 'error'; text: string; at: string }
    | { kind: 'debt'; text: string; at: string }
    | { kind: 'map'; text: string; at: string }
    | { kind: 'error_purge'; key: string; at: string }
    | { kind: 'debt_purge'; key: string; at: string }
) => Promise<void> | void;

export class Cortex {
  /**
   * Optional hook invoked after every write. Wiring it here — rather than
   * calling the search engine from each caller — is what guarantees the miner
   * path gets indexed too. Before this, the miner wrote straight to disk and
   * 91% of the brain never reached the index.
   */
  private indexer: Indexer | null = null;
  private emitter: Emitter | null = null;

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
    action: 'created' | 'updated' | 'skipped';
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
  }> {
    // Credentials never make it to disk. The sentence around them survives, so
    // "the deploy token is [REDACTED: npm token]" still records that a token
    // exists and what kind — the knowledge without the liability.
    const limpio = redact(content);
    content = limpio.text;

    let neuron: Neuron | null = null;
    let action: 'created' | 'updated' | 'skipped' = 'updated';

    if (options?.neuronId) {
      neuron = await this.peek(options.neuronId);
    }
    if (!neuron) {
      neuron = await this.findByName(topic);
    }

    if (!neuron) {
      if (options?.createIfMissing === false) {
        return { neuron: null, action: 'skipped', superseded: 0, supersedes_unmatched: options?.supersedes || [], near_duplicates: [], redacted: limpio.found };
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
            const isDuplicate = n.facts.some(
              f => f.text.toLowerCase() === content.toLowerCase()
            );
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
              n.facts.push(fact);
              this.tally.facts++;
              this.tally.topics.add(n.id);
              emitir = { kind: 'fact' as const, text: content, fid: id,
                         conf: fact.confidence, at: fact.added, src: fact.source };
            }
            break;
          }
          case 'decision': {
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
    await this.reindex(final);
    // Preferences are never emitted: they are the field most likely to hold a
    // key and the least likely to be worth sharing.
    if (emitir) await this.emit(final.id, emitir);
    return { neuron: final, action, superseded, supersedes_unmatched: supersedesUnmatched, near_duplicates: nearDuplicates, redacted: limpio.found };
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

    let revised = 0;
    let unmatched: string[] = targets.slice();
    const actualizada = await updateJSON<Neuron>(
      this.brain.paths.neuron(neuron.id),
      current => {
        const n = current || neuron;
        const retirado = this.retire(
          n,
          targets,
          options?.replacedBy,
          options?.status || 'superseded',
          options?.note
        );
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
      // 'active' is not a retirement, so it is never emitted as one.
      const estado: 'superseded' | 'retracted' =
        options?.status === 'retracted' ? 'retracted' : 'superseded';
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

    // Apply limit
    const limit = options?.limit || 50;
    return neurons.slice(0, limit);
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

    const sello = now().replace(/[:.]/g, '-');
    const backup = `${this.brain.paths.quarantine}/${found.id}.${sello}.json`;
    await writeJSON(backup, found);

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
