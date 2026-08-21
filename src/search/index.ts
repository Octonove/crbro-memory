// ─── CRBRO Search Engine ─────────────────────────────────────────
// Chunk-level retrieval powered by Orama (BM25) with late interaction.
//
// WHY CHUNKS AND NOT WHOLE NEURONS
// Until v1.4 the whole neuron was indexed as a single document, with every
// fact concatenated into one field. BM25 normalises term frequency by
// document length, so on a real brain (median neuron 90 chars, largest
// 342,302 chars) the most valuable neuron scored near zero for any single
// term while a 90-char scrap outranked it. The system punished its own best
// memories: the more you saved about a project, the less findable it became.
//
// Now every fact / decision / pattern / preference is its own document, plus
// one header document per neuron carrying name and tags (which is what keeps
// search-by-name working). Scoring runs per term and recombines, so a neuron
// wins by having ONE chunk that covers the query, not by being short.

import { create, insert, search, remove, save, load } from '@orama/orama';
import type { AnyOrama, RawData } from '@orama/orama';
import { readJSON, writeJSON, listJSONFiles, fileExists, deleteJSON, fileMtime, newestMtime } from '../utils/fs.js';
import { chunkId } from '../utils/hash.js';
import { queryTerms, variants } from './tokenize.js';
import type { Brain } from '../engine/brain.js';
import type { Neuron, SearchResult, Fact } from '../types/index.js';

/** Bump when the schema changes so old on-disk indexes are rebuilt, not loaded. */
export const INDEX_VERSION = 2;

/** Weight given to a neuron for each *additional* chunk that matches. */
const BREADTH_BONUS = 0.05;
/** Cap on the breadth bonus — breadth is a tiebreaker, never the main signal. */
const BREADTH_CAP = 0.25;
/** Exponent on term coverage. >1 punishes chunks that only match one term. */
const COVERAGE_EXPONENT = 1.5;
/** Debounce before writing the index to disk after a learn. */
const PERSIST_DEBOUNCE_MS = 5000;

const SCHEMA = {
  id: 'string' as const,       // "<neuron_id>#<hash>"  — must be `id` for Orama
  neuron: 'string' as const,
  name: 'string' as const,
  text: 'string' as const,
  kind: 'string' as const,     // header | fact | decision | pattern | preference
  domain: 'string' as const,
  tags: 'string' as const,
  added: 'string' as const,
  heat: 'number' as const,
};

interface StoredIndex {
  v: number;
  data: RawData;
}

interface ChunkHit {
  neuron: string;
  name: string;
  domain: string;
  text: string;
  kind: string;
  added: string;
  heat: number;
  score: number;
  matched: number;
}

export class SearchEngine {
  private db: AnyOrama | null = null;
  private docCount = 0;
  private dirty = false;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(private brain: Brain) {}

  // ─── Lifecycle ─────────────────────────────────────────────────

  /**
   * Load the index from disk, or rebuild it if missing / stale / corrupt.
   *
   * Version check matters: Orama's `load()` does NOT throw when the stored
   * schema differs — it silently overwrites the live schema with the old one,
   * so the try/catch never fires and every later search fails with
   * `Invalid property name`, permanently, on every boot. Reading the version
   * ourselves is the only reliable guard.
   */
  async init(): Promise<void> {
    const indexPath = this.brain.paths.chunksIndex();

    if (await fileExists(indexPath)) {
      try {
        const stored = await readJSON<StoredIndex>(indexPath);
        if (stored && stored.v === INDEX_VERSION && stored.data && !(await this.isStale())) {
          this.db = create({ schema: SCHEMA });
          load(this.db, stored.data);
          this.docCount = this.countDocs(stored.data);
          return;
        }
      } catch {
        // Corrupted — fall through to rebuild.
      }
    }

    await this.rebuild();
  }

  /**
   * Has the cortex moved on without the index?
   *
   * This used to be impossible to notice: init() only rebuilt when the file
   * was missing, the version had changed or the JSON was corrupt — never
   * because it had simply fallen behind. So a lost flush, or a second client
   * writing neurons while this one held a stale index in memory, left those
   * facts invisible to recall indefinitely. On the reference brain the index
   * was five and a half hours behind the newest neuron, and a term saved that
   * afternoon returned nothing at all.
   */
  private async isStale(): Promise<boolean> {
    const indexAt = await fileMtime(this.brain.paths.chunksIndex());
    if (indexAt === 0) return true;
    const cortexAt = await newestMtime(this.brain.paths.cortex);
    // One second of slack: a write landing during a rebuild is not staleness.
    return cortexAt > indexAt + 1000;
  }

  /**
   * Rebuild the whole index from the cortex.
   * One bad neuron must not take the server down with it, so every neuron
   * is isolated: CRBRO is published and other people's brains are not ours
   * to assume well-formed.
   */
  async rebuild(): Promise<number> {
    this.db = create({ schema: SCHEMA });
    this.docCount = 0;

    const ids = await listJSONFiles(this.brain.paths.cortex);

    for (const id of ids) {
      try {
        const neuron = await readJSON<Neuron>(this.brain.paths.neuron(id));
        if (!neuron) continue;
        await this.insertNeuronChunks(neuron);
      } catch {
        // Skip unreadable neuron, keep going.
      }
    }

    await this.persist();
    await this.dropLegacyIndex();
    return this.docCount;
  }

  /**
   * Re-index a single neuron: drop its old chunks, insert the current ones.
   */
  async indexNeuron(neuron: Neuron): Promise<void> {
    if (!this.db) await this.init();
    if (!this.db) return;

    await this.removeNeuronChunks(neuron.id);
    await this.insertNeuronChunks(neuron);
    this.markDirty();
  }

  /** Write the index to disk now. */
  async persist(): Promise<void> {
    if (!this.db) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const payload: StoredIndex = { v: INDEX_VERSION, data: save(this.db) };
    // Not pretty-printed: this file reaches tens of MB and indentation costs
    // ~25% of both size and write time for something no human reads.
    await writeJSON(this.brain.paths.chunksIndex(), payload, { pretty: false });
    this.dirty = false;
  }

  /** Flush if there are unsaved changes. Called on consolidate/shutdown. */
  async flush(): Promise<void> {
    if (this.dirty) await this.persist();
  }

  // ─── Search ────────────────────────────────────────────────────

  /**
   * Find neurons matching a query.
   *
   * Late interaction: each query term is searched separately and its scores
   * normalised against the best score for that term, then a chunk's score is
   * the sum of its normalised hits weighted by how much of the query it
   * covers. This is what stops one very common term from deciding the ranking
   * and what makes a chunk matching five of six terms beat a scrap matching one.
   */
  async search(
    query: string,
    options?: { domain?: string; limit?: number }
  ): Promise<SearchResult[]> {
    if (!this.db) await this.init();
    if (!this.db) return [];

    const limit = options?.limit || 10;
    const terms = queryTerms(query);
    if (terms.length === 0) return [];

    const perChunk = new Map<string, ChunkHit>();

    for (const term of terms) {
      const hits = await this.searchTerm(term, options?.domain);
      if (hits.length === 0) continue;

      const best = hits[0].score || 1;

      for (const hit of hits) {
        const doc = hit.document as any;
        const key = doc.id as string;
        const normalised = best > 0 ? hit.score / best : 0;

        const existing = perChunk.get(key);
        if (existing) {
          existing.score += normalised;
          existing.matched += 1;
        } else {
          perChunk.set(key, {
            neuron: doc.neuron,
            name: doc.name,
            domain: doc.domain,
            text: doc.text,
            kind: doc.kind,
            added: doc.added,
            heat: doc.heat || 0,
            score: normalised,
            matched: 1,
          });
        }
      }
    }

    if (perChunk.size === 0) return [];

    // Coverage weighting, then collapse chunks into their neurons.
    const byNeuron = new Map<string, { best: ChunkHit; extra: number }>();

    for (const chunk of perChunk.values()) {
      const coverage = chunk.matched / terms.length;
      chunk.score = chunk.score * Math.pow(coverage, COVERAGE_EXPONENT);

      const current = byNeuron.get(chunk.neuron);
      if (!current) {
        byNeuron.set(chunk.neuron, { best: chunk, extra: 0 });
      } else if (chunk.score > current.best.score) {
        byNeuron.set(chunk.neuron, { best: chunk, extra: current.extra + 1 });
      } else {
        current.extra += 1;
      }
    }

    const results: SearchResult[] = [];
    for (const { best, extra } of byNeuron.values()) {
      const breadth = Math.min(extra * BREADTH_BONUS, BREADTH_CAP);
      results.push({
        neuron_id: best.neuron,
        name: best.name,
        domain: best.domain,
        relevance_score: Math.round((best.score + breadth) * 1000) / 1000,
        matching_content: best.text,
        matched_kind: best.kind,
        matched_added: best.added || '',
        heat: best.heat,
      });
    }

    results.sort((a, b) => b.relevance_score - a.relevance_score);
    return results.slice(0, limit);
  }

  // ─── Internals ─────────────────────────────────────────────────

  /**
   * Search one term. Exact first; only if a reasonably long term finds
   * nothing do we allow a single edit of slack, which covers typos without
   * the indiscriminate noise of the old `tolerance: 2` (measured: it matched
   * 1,166 of 1,183 documents, i.e. the ranking was noise).
   */
  private async searchTerm(term: string, domain?: string): Promise<any[]> {
    const run = async (tolerance: number, cual: string = term) => {
      const params: any = {
        term: cual,
        properties: ['text', 'name', 'tags'],
        boost: { name: 2, text: 1, tags: 1 },
        limit: Math.max(this.docCount, 10),
        tolerance,
      };
      if (domain) params.where = { domain: { eq: domain } };
      const res = await search(this.db as AnyOrama, params);
      return res.hits as any[];
    };

    let hits = await run(0);

    // Try the other grammatical number too, and keep the best score each
    // chunk got. Counting as one term keeps query coverage honest: asking
    // about "facturas" should not score twice for also matching "factura".
    const otras = variants(term).filter(v => v !== term);
    if (otras.length > 0) {
      const mejor = new Map<string, any>();
      for (const h of hits) mejor.set(h.document.id, h);
      for (const v of otras) {
        for (const h of await run(0, v)) {
          const previo = mejor.get(h.document.id);
          if (!previo || h.score > previo.score) mejor.set(h.document.id, h);
        }
      }
      hits = [...mejor.values()].sort((a, b) => b.score - a.score);
    }

    if (hits.length === 0 && term.length >= 5) {
      hits = await run(1);
    }
    return hits;
  }

  /** Build and insert every chunk of a neuron. */
  private async insertNeuronChunks(neuron: Neuron): Promise<void> {
    if (!this.db) return;

    const tags = Array.isArray(neuron.tags) ? neuron.tags.join(' ') : '';
    const base = {
      neuron: neuron.id,
      name: neuron.name || neuron.id,
      domain: neuron.domain || 'general',
      tags,
      heat: typeof neuron.heat === 'number' ? neuron.heat : 0,
    };

    // Header chunk — carries name, summary and tags. This is what preserves
    // search-by-name, which is the one thing that worked before.
    const headerText = [neuron.name, neuron.summary, tags]
      .filter(Boolean)
      .join(' — ');
    await this.put({
      ...base,
      id: chunkId(neuron.id, `header:${headerText}`),
      text: headerText,
      kind: 'header',
      added: neuron.created || '',
    });

    for (const fact of neuron.facts || []) {
      if (!fact || !fact.text) continue;
      if (isRetired(fact)) continue;
      await this.put({
        ...base,
        id: chunkId(neuron.id, fact.text),
        text: fact.text,
        kind: 'fact',
        added: fact.added || '',
      });
    }

    for (const decision of neuron.decisions || []) {
      if (!decision || !decision.text) continue;
      const text = decision.rationale
        ? `${decision.text} — ${decision.rationale}`
        : decision.text;
      await this.put({
        ...base,
        id: chunkId(neuron.id, text),
        text,
        kind: 'decision',
        added: decision.date || '',
      });
    }

    for (const pattern of neuron.patterns || []) {
      if (!pattern) continue;
      await this.put({
        ...base,
        id: chunkId(neuron.id, pattern),
        text: pattern,
        kind: 'pattern',
        added: '',
      });
    }

    for (const pref of neuron.preferences || []) {
      if (!pref) continue;
      await this.put({
        ...base,
        id: chunkId(neuron.id, pref),
        text: pref,
        kind: 'preference',
        added: '',
      });
    }
  }

  private async put(doc: Record<string, unknown>): Promise<void> {
    try {
      await insert(this.db as AnyOrama, doc as any);
      this.docCount++;
    } catch {
      // Duplicate id (identical text twice in one neuron) — nothing to add.
    }
  }

  /** Drop every chunk belonging to a neuron. */
  private async removeNeuronChunks(neuronId: string): Promise<void> {
    if (!this.db) return;
    try {
      const res = await search(this.db, {
        term: '',
        where: { neuron: { eq: neuronId } } as any,
        limit: 10000,
      } as any);
      for (const hit of res.hits as any[]) {
        try {
          await remove(this.db, hit.document.id);
          this.docCount = Math.max(0, this.docCount - 1);
        } catch {
          // Already gone.
        }
      }
    } catch {
      // `where` on a non-filterable field, or empty index — ignore.
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist().catch(() => { /* disk error — keep serving */ });
    }, PERSIST_DEBOUNCE_MS);
    // Never hold the process open just to flush the index.
    if (typeof this.persistTimer.unref === 'function') this.persistTimer.unref();
  }

  private countDocs(data: RawData): number {
    try {
      const store = (data as any)?.internalDocumentIDStore?.internalIdToId;
      if (Array.isArray(store)) return store.length;
      const docs = (data as any)?.docs?.docs;
      if (docs) return Object.keys(docs).length;
    } catch {
      // Unknown shape — a floor of 0 only affects the per-term limit.
    }
    return 0;
  }

  /**
   * Remove the pre-v2 index once a rebuild has succeeded. It is dead weight
   * (25 MB on the reference brain) and nothing reads it any more. Downgrading
   * to an older CRBRO simply finds no index and rebuilds its own.
   */
  private async dropLegacyIndex(): Promise<void> {
    try {
      await deleteJSON(this.brain.paths.searchIndex());
    } catch {
      // Best effort.
    }
  }
}

/** A fact that has been superseded or retracted must not surface in recall. */
function isRetired(fact: Fact): boolean {
  return fact.status === 'superseded' || fact.status === 'retracted';
}
