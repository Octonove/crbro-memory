// ─── Rare words weigh more (2.7.2) ────────────────────────────────
//
// Each query term is normalised against its own best hit, so before 2.7.2 a
// word found all over the brain counted exactly as much as the one word that
// names the thing: "hetzner mes" tied the Hetzner fact with every fact that
// says "mes", and file order picked the winner. These tests pin the fix and
// its switch.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { SearchEngine } from '../src/search/index.js';

describe('a rare query word outweighs a common one', () => {
  let root: string;
  let engine: SearchEngine;

  const RARE = 'Las webs de los clientes están alojadas en un VPS de Hetzner en Falkenstein.';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-idf-'));
    const brain = new Brain(root);
    await brain.initialize();
    const cortex = new Cortex(brain);
    engine = new SearchEngine(brain);
    await engine.init();
    cortex.setIndexer(n => engine.indexNeuron(n));
    process.env.CRBRO_RECENCY = '0';
    // Learned first, so the file-order tiebreak would favour the common facts.
    for (let i = 0; i < 12; i++) {
      await cortex.learn(`Gasto ${i}`, 'fact', `El recibo número ${i} llega una vez al mes por domiciliación.`);
    }
    await cortex.learn('Servidores', 'fact', RARE);
  });

  afterEach(async () => {
    delete process.env.CRBRO_RECENCY;
    delete process.env.CRBRO_IDF;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('ranks the fact with the rare word first, well clear of the common ones', async () => {
    const hits = await engine.search('hetzner mes');
    expect(hits[0].matching_content).toBe(RARE);
    expect(hits[0].relevance_score).toBeGreaterThan(2 * hits[1].relevance_score);
  });

  it('CRBRO_IDF=0 brings back the old weighting: the rare word ties with the common one', async () => {
    process.env.CRBRO_IDF = '0';
    const hits = await engine.search('hetzner mes');
    const rare = hits.find(h => h.matching_content === RARE);
    const common = hits.find(h => h.matching_content !== RARE);
    expect(rare).toBeDefined();
    expect(common).toBeDefined();
    expect(rare!.relevance_score).toBe(common!.relevance_score);
  });
});
