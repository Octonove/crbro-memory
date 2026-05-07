// ─── CRBRO Search Engine ─────────────────────────────────────────
// Hybrid search powered by Orama (text + BM25 + fuzzy)

import { create, insert, search, remove, save, load } from '@orama/orama';
import type { AnyOrama, RawData } from '@orama/orama';
import { readJSON, writeJSON, listJSONFiles, fileExists } from '../utils/fs.js';
import type { Brain } from '../engine/brain.js';
import type { Neuron, SearchResult } from '../types/index.js';

// Orama schema for indexing neurons
const SCHEMA = {
  id: 'string' as const,
  name: 'string' as const,
  summary: 'string' as const,
  facts: 'string' as const,
  domain: 'string' as const,
  tags: 'string' as const,
  heat: 'number' as const,
};

export class SearchEngine {
  private db: AnyOrama | null = null;

  constructor(private brain: Brain) {}

  /**
   * Initialize or restore the search index.
   */
  async init(): Promise<void> {
    const indexPath = this.brain.paths.searchIndex();
    const indexExists = await fileExists(indexPath);

    if (indexExists) {
      try {
        const savedData = await readJSON<RawData>(indexPath);
        if (savedData) {
          // Create a fresh db then load data into it
          this.db = create({ schema: SCHEMA });
          load(this.db, savedData);
          return;
        }
      } catch {
        // Index corrupted — rebuild
      }
    }

    // Create fresh index
    await this.rebuild();
  }

  /**
   * Rebuild the entire search index from cortex files.
   */
  async rebuild(): Promise<number> {
    this.db = create({ schema: SCHEMA });

    const ids = await listJSONFiles(this.brain.paths.cortex);
    let indexed = 0;

    for (const id of ids) {
      const neuron = await readJSON<Neuron>(this.brain.paths.neuron(id));
      if (!neuron) continue;

      await insert(this.db, {
        id: neuron.id,
        name: neuron.name,
        summary: neuron.summary,
        facts: neuron.facts.map(f => f.text).join(' | '),
        domain: neuron.domain,
        tags: neuron.tags.join(' '),
        heat: neuron.heat,
      });
      indexed++;
    }

    // Save index to disk
    await this.persist();
    return indexed;
  }

  /**
   * Index a single neuron (for real-time updates).
   */
  async indexNeuron(neuron: Neuron): Promise<void> {
    if (!this.db) await this.init();
    if (!this.db) return;

    // Remove existing entry if present (ignore errors)
    try {
      await remove(this.db, neuron.id);
    } catch {
      // Not found — fine
    }

    await insert(this.db, {
      id: neuron.id,
      name: neuron.name,
      summary: neuron.summary,
      facts: neuron.facts.map(f => f.text).join(' | '),
      domain: neuron.domain,
      tags: neuron.tags.join(' '),
      heat: neuron.heat,
    });
  }

  /**
   * Search for neurons matching a query.
   */
  async search(
    query: string,
    options?: { domain?: string; limit?: number }
  ): Promise<SearchResult[]> {
    if (!this.db) await this.init();
    if (!this.db) return [];

    const limit = options?.limit || 10;

    const searchParams: any = {
      term: query,
      properties: ['name', 'summary', 'facts', 'tags'],
      boost: { name: 3, summary: 2, facts: 1, tags: 1 },
      limit,
      tolerance: 2,
    };

    // Domain filter
    if (options?.domain) {
      searchParams.where = { domain: { eq: options.domain } };
    }

    const results = await search(this.db, searchParams);

    return results.hits.map((hit: any) => ({
      neuron_id: hit.document.id as string,
      name: hit.document.name as string,
      domain: hit.document.domain as string,
      relevance_score: Math.round(hit.score * 1000) / 1000,
      matching_content: (hit.document.summary as string) || (hit.document.facts as string)?.substring(0, 200) || '',
      heat: (hit.document.heat as number) || 0,
    }));
  }

  /**
   * Persist the search index to disk.
   */
  async persist(): Promise<void> {
    if (!this.db) return;
    const data = save(this.db);
    await writeJSON(this.brain.paths.searchIndex(), data);
  }
}
