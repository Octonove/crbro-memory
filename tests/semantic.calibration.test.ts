// ─── The semantic layer without the model (2.11) ─────────────────
//
// The real model is ~500 MB and the suite never downloads it, so these
// tests drive the engine with a stand-in vector index whose cosines are
// chosen by the test:
//  B3   strong is calibrated per brain (noise top + margin), not a fixed 0.86
//  B13  a query waits a bounded time for the model, then answers keyword-only
//  B14  vectors missing from the index are refilled, orphans pruned
//  E3   the model files are pinned by hash, the runtime by exact version, and
//       no query may download

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { SearchEngine } from '../src/search/index.js';
import { SemanticIndex, SEMANTIC_RUNTIME, SEMANTIC_MODEL_FILES, verifyModelFiles } from '../src/search/semantic.js';
import { factId } from '../src/utils/hash.js';

/** A vector index whose cosine for (query, chunk text) is decided by `score`. */
class FakeSemantic {
  texts = new Map<string, string>();
  delayMs = 0;
  queries = 0;
  constructor(public score: (q: string, text: string) => number) {}
  count() { return this.texts.size; }
  ready() { return true; }
  idList() { return [...this.texts.keys()]; }
  has(id: string) { return this.texts.has(id); }
  warm() { /* nothing */ }
  async load() { /* nothing */ }
  async persist() { /* nothing */ }
  async upsert(entries: Array<{ id: string; text: string }>) { for (const e of entries) this.texts.set(e.id, e.text); return entries.length; }
  remove(ids: Iterable<string>) { let n = 0; for (const id of ids) if (this.texts.delete(id)) n++; return n; }
  async query(q: string, k: number) {
    this.queries++;
    if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs));
    return [...this.texts].map(([id, t]) => ({ id, score: this.score(q, t) }))
      .sort((a, b) => b.score - a.score).slice(0, k);
  }
}

let root: string; let brain: Brain; let engine: SearchEngine; let fake: FakeSemantic;
const day = '2026-06-01T10:00:00.000Z';
async function put(id: string, facts: string[]) {
  const n = { id, name: id, domain: 'general', type: 'project', created: day, last_accessed: day, access_count: 1, heat: 0.5, summary: '',
    facts: facts.map(text => ({ text, confidence: 0.9, added: day, source: 'test', id: factId(text) })),
    decisions: [], patterns: [], preferences: [], connections: [], tags: [], errors: [], debts: [] };
  await fs.writeFile(brain.paths.neuron(id), JSON.stringify(n));
  await engine.indexNeuron(n as any);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-semcal-'));
  brain = new Brain(root); await brain.initialize();
  engine = new SearchEngine(brain);
  // Noise sits at 0.86-0.875 on this "brain"; the one true neighbour of the
  // question about RAM reaches 0.91. A fixed 0.86 would call the noise strong.
  fake = new FakeSemantic((q, t) => {
    if (/memoria|RAM/i.test(q) && /16 GB de RAM/.test(t)) return 0.91;
    let h = 0; for (const c of q + t) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return 0.86 + (h % 16) / 1000;
  });
  (engine as any).semantic = fake;
  await engine.init();
  const filler = Array.from({ length: 70 }, (_, i) => `Nota de relleno número ${i} sobre facturas, clientes y proveedores varios.`);
  await put('project_relleno', filler);
  await put('project_srv', ['El servidor de producción tiene 16 GB de RAM.']);
  process.env.CRBRO_SEMANTIC_FLOOR = '0.84';
});
afterEach(async () => {
  delete process.env.CRBRO_SEMANTIC_FLOOR;
  delete process.env.CRBRO_SEMANTIC_WAIT_MS;
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('B3: strong is calibrated on this brain', () => {
  it('measures the noise top and sets strong above it', async () => {
    const cal = await engine.calibrate();
    expect(cal).not.toBeNull();
    expect(cal!.noise_p95).toBeGreaterThanOrEqual(0.86);
    expect(cal!.noise_p95).toBeLessThan(0.876);
    expect(cal!.strong).toBeCloseTo(cal!.noise_p95 + 0.01, 3);
  });

  it('a nonsense query is weak; the real neighbour is strong', async () => {
    await engine.calibrate();
    const nada = await engine.search('xqzv wkrp jjhg');
    for (const r of nada) expect(r.confidence).toBe('weak');
    const ram = await engine.search('cuánta memoria tiene la máquina principal');
    const top = ram.find(r => r.neuron_id === 'project_srv');
    expect(top?.confidence).toBe('strong');
    expect(top?.semantic_score).toBe(0.91);
  });

  it('a nonsense query comes back as no_answer', async () => {
    await engine.calibrate();
    const r = await engine.searchManyWithStats(['xqzv wkrp jjhg'], { limit: 5 });
    expect(r.no_answer).toBe(true);
    expect(r.results.length).toBeLessThanOrEqual(1);
  });

  it('the calibration is saved with the index and loaded back', async () => {
    const cal = await engine.calibrate();
    await engine.persist();
    const stored = JSON.parse(await fs.readFile(brain.paths.chunksIndex(), 'utf8'));
    expect(stored.calibration.strong).toBe(cal!.strong);
    const again = new SearchEngine(new Brain(root));
    (again as any).semantic = fake;
    await again.init();
    expect(again.semanticCalibration()?.strong).toBe(cal!.strong);
  });
});

describe('B13: a bounded wait for the model', () => {
  it('answers keyword-only and says warming when the model is late', async () => {
    fake.delayMs = 400;
    process.env.CRBRO_SEMANTIC_WAIT_MS = '50';
    const t0 = Date.now();
    const r = await engine.searchManyWithStats(['servidor producción RAM'], { limit: 5 });
    expect(Date.now() - t0).toBeLessThan(350);
    expect(r.semantic).toBe('warming');
    expect(r.results[0].neuron_id).toBe('project_srv');
    expect(r.results[0].semantic_score).toBeUndefined();
  });
});

describe('B14: vectors follow the index', () => {
  it('refills missing vectors and prunes orphans at init', async () => {
    const before = fake.count();
    expect(before).toBeGreaterThan(0);
    fake.texts.delete([...fake.texts.keys()][0]);           // a vector lost
    fake.texts.set('project_gone#deadbeef0000', 'huérfano'); // a vector of nothing
    const again = new SearchEngine(new Brain(root));
    (again as any).semantic = fake;
    await engine.persist();
    await again.init();
    await again.awaitEmbeddings();
    expect(fake.has('project_gone#deadbeef0000')).toBe(false);
    expect(fake.count()).toBe(before);
    expect(again.semanticCoverage()).toEqual({ vectors: before, chunks: before });
  });
});

describe('E3: pinned runtime and model, no download from a query', () => {
  it('pins transformers.js to an exact version', () => {
    expect(SEMANTIC_RUNTIME).toMatch(/^@huggingface\/transformers@\d+\.\d+\.\d+$/);
  });

  it('refuses model files that do not match the pinned hashes', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-semhome-'));
    try {
      expect(await verifyModelFiles(home)).toMatch(/missing/);
      const dir = path.join(home, 'models', 'Xenova', 'multilingual-e5-small');
      await fs.mkdir(path.join(dir, 'onnx'), { recursive: true });
      for (const rel of Object.keys(SEMANTIC_MODEL_FILES)) await fs.writeFile(path.join(dir, ...rel.split('/')), 'not the model');
      expect(await verifyModelFiles(home)).toMatch(/does not match the pinned hash/);
    } finally { await fs.rm(home, { recursive: true, force: true }); }
  });

  it('a torn vectors pair (data and meta of different writes) loads as empty', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-vec-'));
    try {
      await fs.writeFile(path.join(dir, 'vectors.f32'), Buffer.alloc(384 * 4 * 2));
      await fs.writeFile(path.join(dir, 'vectors.meta.json'), JSON.stringify({ model: 'Xenova/multilingual-e5-small', dtype: 'q8', dim: 384, ids: ['a', 'b'], bytes: 384 * 4 * 3 }));
      const idx = new SemanticIndex(dir);
      await idx.load();
      expect(idx.count()).toBe(0);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
