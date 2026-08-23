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

/**
 * Bump when the schema changes so old on-disk indexes are rebuilt, not loaded.
 * v3: chunk removal used to rely on an Orama `where` filter that silently
 * matched nothing, so every index built before it carries chunks for facts
 * that were later revised or forgotten. The bump forces those poisoned
 * indexes to rebuild once, which heals them.
 */
export const INDEX_VERSION = 3;

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

  /**
   * Which chunk ids belong to which neuron. Removal used to ask Orama for
   * them with a `where` filter on a plain string field — a query that
   * returns nothing, silently, so "re-index this neuron" never removed a
   * thing and revised facts kept surfacing in recall (observed live: the
   * retired version of a fact outranking its own correction). We are the
   * ones inserting every chunk, so we simply remember what we inserted.
   */
  private chunksByNeuron = new Map<string, Set<string>>();

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
          if (this.recoverChunkMap(stored.data)) return;
          // Could not tell which chunk belongs to which neuron — without
          // that, removal is blind, so a rebuild is the only safe answer.
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
    this.chunksByNeuron.clear();

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

    // Coverage weighting, then group chunks by neuron, best first.
    const byNeuron = new Map<string, ChunkHit[]>();

    for (const chunk of perChunk.values()) {
      const coverage = chunk.matched / terms.length;
      chunk.score = chunk.score * Math.pow(coverage, COVERAGE_EXPONENT);
      const list = byNeuron.get(chunk.neuron);
      if (list) list.push(chunk);
      else byNeuron.set(chunk.neuron, [chunk]);
    }
    for (const list of byNeuron.values()) list.sort((a, b) => b.score - a.score);

    return this.materializeResults([...byNeuron.values()], limit);
  }

  /**
   * Turn per-neuron chunk lists into results, validating each chunk against
   * the neuron on disk before serving it.
   *
   * Two failures end here. An index can carry chunks for knowledge that was
   * revised, forgotten or rewritten (pre-v3 indexes; a second writer; a lost
   * flush) — and serving a retired fact is the one failure a memory system
   * must not have, since the wrong version tends to outrank its own
   * correction. And a neuron whose BEST chunk went stale must not vanish
   * from the answer while it still holds live knowledge that matched: we
   * fall back to its next valid chunk instead. Stale neurons are quietly
   * re-indexed; chunks of deleted neurons are removed on the spot.
   */
  private async materializeResults(
    porNeurona: ChunkHit[][],
    limit: number
  ): Promise<SearchResult[]> {
    // Only the plausible head pays the neuron reads: nothing below it could
    // reach the answer even if everything above dropped out.
    porNeurona.sort((a, b) => b[0].score - a[0].score);
    const candidatos = porNeurona.slice(0, Math.max(limit * 3, limit + 8));

    const resultados: SearchResult[] = [];

    for (const chunks of candidatos) {
      const neuronId = chunks[0].neuron;
      let neuron: Neuron | null = null;
      let legible = true;
      try {
        neuron = await readJSON<Neuron>(this.brain.paths.neuron(neuronId));
      } catch {
        legible = false;   // exists but unreadable — never censor on that
      }

      if (legible && neuron === null) {
        // The neuron is gone; its chunks are litter. Sweep and move on.
        await this.removeNeuronChunks(neuronId);
        this.markDirty();
        continue;
      }

      let elegido: ChunkHit | null = null;
      let huboRancio = false;
      for (const chunk of chunks) {
        if (!legible || neuron === null || this.chunkVive(chunk, neuron)) {
          elegido = chunk;
          break;
        }
        huboRancio = true;
      }

      if (huboRancio && neuron) {
        // Heal in the background, never block recall.
        void this.indexNeuron(neuron).catch(() => { /* best effort */ });
      }
      if (!elegido) continue;

      const breadth = Math.min((chunks.length - 1) * BREADTH_BONUS, BREADTH_CAP);
      resultados.push({
        neuron_id: elegido.neuron,
        name: elegido.name,
        domain: elegido.domain,
        relevance_score: Math.round((elegido.score + breadth) * 1000) / 1000,
        matching_content: elegido.text,
        matched_kind: elegido.kind,
        matched_added: elegido.added || '',
        heat: elegido.heat,
        ...(neuron?.map?.text ? { has_map: true } : {}),
      });
    }

    resultados.sort((a, b) => b.relevance_score - a.relevance_score);
    return resultados.slice(0, limit);
  }

  /** Does the chunk still describe something the neuron holds as current? */
  private chunkVive(chunk: ChunkHit, neuron: Neuron): boolean {
    switch (chunk.kind) {
      case 'fact':
        return (neuron.facts || []).some(f => !isRetired(f) && f.text === chunk.text);
      case 'error':
        return (neuron.errors || []).includes(chunk.text);
      case 'debt':
        return (neuron.debts || []).includes(chunk.text);
      case 'map':
        return neuron.map?.text === chunk.text;
      case 'pattern':
        return (neuron.patterns || []).includes(chunk.text);
      case 'preference':
        return (neuron.preferences || []).includes(chunk.text);
      case 'decision':
        return (neuron.decisions || []).some(d => {
          const texto = d.rationale ? `${d.text} — ${d.rationale}` : d.text;
          return texto === chunk.text;
        });
      default:
        // Headers describe the neuron itself; identity, not content.
        return true;
    }
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
      const res = await search(this.db as AnyOrama, params);
      const hits = res.hits as any[];
      // Filtered here, not with an Orama `where` clause: a `where` on a
      // plain string field matches nothing at all, so the old code turned
      // every domain-scoped recall into zero results (measured).
      return domain ? hits.filter(h => (h.document as any).domain === domain) : hits;
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

    for (const err of neuron.errors || []) {
      if (!err) continue;
      await this.put({
        ...base,
        id: chunkId(neuron.id, `error:${err}`),
        text: err,
        kind: 'error',
        added: '',
      });
    }

    for (const debt of neuron.debts || []) {
      if (!debt) continue;
      await this.put({
        ...base,
        id: chunkId(neuron.id, `debt:${debt}`),
        text: debt,
        kind: 'debt',
        added: '',
      });
    }

    if (neuron.map && neuron.map.text) {
      await this.put({
        ...base,
        id: chunkId(neuron.id, `map:${neuron.map.text}`),
        text: neuron.map.text,
        kind: 'map',
        added: neuron.map.updated || '',
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
    // Registered even on duplicate: the id is in the index either way, and
    // an unregistered chunk is one that removal can never reach again.
    const neuron = String(doc.neuron || '');
    if (!neuron) return;
    let ids = this.chunksByNeuron.get(neuron);
    if (!ids) {
      ids = new Set<string>();
      this.chunksByNeuron.set(neuron, ids);
    }
    ids.add(String(doc.id));
  }

  /**
   * Drop every chunk belonging to a neuron.
   *
   * From our own ledger, chunk by chunk — never from an Orama `where`
   * filter. The old filter (string field, empty term) matched nothing and
   * threw nothing, so removal reported success while removing zero chunks,
   * and everything ever revised or forgotten stayed searchable.
   */
  private async removeNeuronChunks(neuronId: string): Promise<void> {
    if (!this.db) return;
    const ids = this.chunksByNeuron.get(neuronId);
    if (!ids) return;
    for (const id of ids) {
      try {
        // remove() returns false (it does not throw) for an absent id, so
        // the count only moves when a document really left the index.
        const fuera = await remove(this.db, id);
        if (fuera) this.docCount = Math.max(0, this.docCount - 1);
      } catch {
        // Already gone.
      }
    }
    this.chunksByNeuron.delete(neuronId);
  }

  /**
   * Rebuild the chunk-ownership ledger from a stored index, so removal keeps
   * working after a load-from-disk. Returns false when the stored shape is
   * not what we expect — the caller then falls back to a full rebuild.
   */
  private recoverChunkMap(data: RawData): boolean {
    try {
      const docs = (data as any)?.docs?.docs;
      if (!docs || typeof docs !== 'object') return false;
      this.chunksByNeuron.clear();
      for (const doc of Object.values(docs) as any[]) {
        if (!doc || !doc.id || !doc.neuron) continue;
        let ids = this.chunksByNeuron.get(doc.neuron);
        if (!ids) {
          ids = new Set<string>();
          this.chunksByNeuron.set(doc.neuron, ids);
        }
        ids.add(String(doc.id));
      }
      return this.chunksByNeuron.size > 0 || this.docCount === 0;
    } catch {
      return false;
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
