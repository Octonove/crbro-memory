// ─── CRBRO Cortex Engine ─────────────────────────────────────────
// Neuron CRUD — create, read, update, list neurons

import { readJSON, writeJSON, updateJSON, listJSONFiles, now } from '../utils/fs.js';
import { neuronId, inferNeuronType, toSnakeCase, legacySnakeCase } from '../utils/ids.js';
import { factId } from '../utils/hash.js';
import { redact, secretKinds } from './secrets.js';
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
  ): Promise<{
    neuron: Neuron | null;
    action: 'created' | 'updated' | 'skipped';
    superseded: number;
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
        return { neuron: null, action: 'skipped', superseded: 0, redacted: limpio.found };
      }
      const nType = options?.neuronType || inferNeuronType(topic);
      const domain = options?.domain || 'general';
      neuron = await this.create(topic, nType, domain);
      action = 'created';
    }

    let superseded = 0;

    // From here on we work on a fresh read inside the lock. Mutating the copy
    // fetched a moment ago and saving it over the top is exactly how a
    // concurrent writer's facts disappeared.
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
                superseded = this.retire(n, options.supersedes, id, 'superseded');
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
              n.facts.push(fact);
              this.tally.facts++;
              this.tally.topics.add(n.id);
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
            break;
          }
          case 'pattern': {
            if (!n.patterns.includes(content)) n.patterns.push(content);
            break;
          }
          case 'preference': {
            if (!n.preferences.includes(content)) n.preferences.push(content);
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
    return { neuron: final, action, superseded, redacted: limpio.found };
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

    let revised = 0;
    const actualizada = await updateJSON<Neuron>(
      this.brain.paths.neuron(neuron.id),
      current => {
        const n = current || neuron;
        revised = this.retire(
          n,
          targets,
          options?.replacedBy,
          options?.status || 'superseded',
          options?.note
        );
        if (revised === 0) return null;
        n.last_accessed = now();
        return n;
      }
    );

    if (revised > 0) {
      // Must reindex, or the correction is silently lost on next boot —
      // which is exactly the failure this feature exists to close.
      await this.reindex((actualizada || neuron) as Neuron);
    }

    return { neuron: (actualizada || neuron) as Neuron, revised };
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
      const before = current.facts.length;
      current.facts = current.facts.filter(f => {
        const fid = (f.id || factId(f.text)).toLowerCase();
        return !(wanted.includes(fid) || wanted.includes(f.text.trim().toLowerCase()));
      });
      removed = before - current.facts.length;
      if (removed === 0) return null;
      current.last_accessed = now();
      return current;
    });

    if (removed > 0 && after) await this.reindex(after);
    return { neuron_id: found.id, removed, backup: removed > 0 ? backup : null };
  }

  /**
   * Which neurons hold something that looks like a credential.
   * Reports the kind and where it is, never the value.
   */
  async auditSecrets(): Promise<Array<{ neuron_id: string; name: string; kinds: string[]; facts: number }>> {
    const out: Array<{ neuron_id: string; name: string; kinds: string[]; facts: number }> = [];
    for (const id of await listJSONFiles(this.brain.paths.cortex)) {
      const n = await readJSON<Neuron>(this.brain.paths.neuron(id));
      if (!n) continue;
      const kinds = new Set<string>();
      let afectados = 0;
      for (const f of n.facts || []) {
        const k = secretKinds(f.text || '');
        if (k.length) {
          afectados++;
          k.forEach(x => kinds.add(x));
        }
      }
      if (afectados > 0) {
        out.push({ neuron_id: n.id, name: n.name, kinds: [...kinds], facts: afectados });
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
