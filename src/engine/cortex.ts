// ─── CRBRO Cortex Engine ─────────────────────────────────────────
// Neuron CRUD — create, read, update, list neurons

import { readJSON, writeJSON, listJSONFiles, now } from '../utils/fs.js';
import { neuronId, inferNeuronType, toSnakeCase, legacySnakeCase } from '../utils/ids.js';
import { factId } from '../utils/hash.js';
import type { Brain } from './brain.js';
import type { Neuron, NeuronType, Fact, Decision, FactStatus } from '../types/index.js';

const TYPE_PREFIX_RE = /^(project_|tech_|lang_|person_|domain_|process_|protocol_)/;

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

export class Cortex {
  /**
   * Optional hook invoked after every write. Wiring it here — rather than
   * calling the search engine from each caller — is what guarantees the miner
   * path gets indexed too. Before this, the miner wrote straight to disk and
   * 91% of the brain never reached the index.
   */
  private indexer: Indexer | null = null;

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
    const neuron = await readJSON<Neuron>(this.brain.paths.neuron(id));
    if (neuron) {
      // Touch — update access time and count
      neuron.last_accessed = now();
      neuron.access_count = (neuron.access_count || 0) + 1;
      await writeJSON(this.brain.paths.neuron(id), neuron);
    }
    return neuron;
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

    const existing = await this.peek(id);
    if (existing) return existing;

    const neuron: Neuron = {
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
    };

    await writeJSON(this.brain.paths.neuron(id), neuron);

    // Only count a neuron that was really created, or the manifest drifts.
    const manifest = await this.brain.getManifest();
    await this.brain.updateManifest({ total_neurons: manifest.total_neurons + 1 });

    return neuron;
  }

  /**
   * Learn — add a fact, decision, pattern or preference to a neuron.
   * Creates the neuron if it does not exist.
   */
  async learn(
    topic: string,
    type: 'fact' | 'decision' | 'pattern' | 'preference',
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
  ): Promise<{ neuron: Neuron | null; action: 'created' | 'updated' | 'skipped'; superseded: number }> {
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
        return { neuron: null, action: 'skipped', superseded: 0 };
      }
      const nType = options?.neuronType || inferNeuronType(topic);
      const domain = options?.domain || 'general';
      neuron = await this.create(topic, nType, domain);
      action = 'created';
    }

    let superseded = 0;

    switch (type) {
      case 'fact': {
        const id = factId(content);
        const isDuplicate = neuron.facts.some(
          f => f.text.toLowerCase() === content.toLowerCase()
        );
        if (!isDuplicate) {
          if (options?.supersedes?.length) {
            superseded = this.retire(neuron, options.supersedes, id, 'superseded');
          }
          const fact: Fact = {
            text: content,
            confidence: options?.confidence ?? 1.0,
            added: now(),
            source: options?.source || 'session',
            id,
            status: 'active',
          };
          if (options?.supersedes?.length) fact.supersedes = options.supersedes;
          neuron.facts.push(fact);
          this.tally.facts++;
          this.tally.topics.add(neuron.id);
        }
        break;
      }
      case 'decision': {
        const decision: Decision = {
          text: content,
          date: now(),
          rationale: options?.rationale || '',
        };
        neuron.decisions.push(decision);
        this.tally.decisions++;
        this.tally.topics.add(neuron.id);
        break;
      }
      case 'pattern': {
        if (!neuron.patterns.includes(content)) {
          neuron.patterns.push(content);
        }
        break;
      }
      case 'preference': {
        if (!neuron.preferences.includes(content)) {
          neuron.preferences.push(content);
        }
        break;
      }
    }

    neuron.last_accessed = now();
    neuron.access_count = (neuron.access_count || 0) + 1;

    if (options?.domain && neuron.domain === 'general') {
      neuron.domain = options.domain;
    }

    await writeJSON(this.brain.paths.neuron(neuron.id), neuron);
    await this.reindex(neuron);
    return { neuron, action, superseded };
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
  ): Promise<{ neuron: Neuron | null; revised: number }> {
    const neuron =
      (await this.peek(neuronRef)) || (await this.findByName(neuronRef));
    if (!neuron) return { neuron: null, revised: 0 };

    const revised = this.retire(
      neuron,
      targets,
      options?.replacedBy,
      options?.status || 'superseded',
      options?.note
    );

    if (revised > 0) {
      neuron.last_accessed = now();
      await writeJSON(this.brain.paths.neuron(neuron.id), neuron);
      // Must reindex, or the correction is silently lost on next boot —
      // which is exactly the failure this feature exists to close.
      await this.reindex(neuron);
    }

    return { neuron, revised };
  }

  /** Flip matching facts to a non-active status. Returns how many changed. */
  private retire(
    neuron: Neuron,
    targets: string[],
    replacedBy: string | undefined,
    status: FactStatus,
    note?: string
  ): number {
    let count = 0;
    const wanted = targets.map(t => t.trim().toLowerCase());

    for (const fact of neuron.facts) {
      if (fact.status === 'superseded' || fact.status === 'retracted') continue;

      const fid = fact.id || factId(fact.text);
      const matches =
        wanted.includes(fid.toLowerCase()) ||
        wanted.includes(fact.text.trim().toLowerCase());
      if (!matches) continue;

      fact.id = fid;
      fact.status = status;
      fact.revised = now();
      if (replacedBy) fact.superseded_by = replacedBy;
      if (note) fact.revision_note = note;
      count++;
    }
    return count;
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
    const neuron = await this.peek(id);
    if (!neuron) return null;

    neuron.summary = summary;
    neuron.last_accessed = now();
    await writeJSON(this.brain.paths.neuron(id), neuron);
    await this.reindex(neuron);
    return neuron;
  }

  /**
   * Add tags to a neuron.
   */
  async addTags(id: string, tags: string[]): Promise<Neuron | null> {
    const neuron = await this.peek(id);
    if (!neuron) return null;

    for (const tag of tags) {
      if (!neuron.tags.includes(tag)) {
        neuron.tags.push(tag);
      }
    }
    await writeJSON(this.brain.paths.neuron(id), neuron);
    await this.reindex(neuron);
    return neuron;
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
