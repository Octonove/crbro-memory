// ─── The opt-in semantic layer (1.14) ────────────────────────────
//
// Two contracts. Off — CRBRO_SEMANTIC=0, or no runtime on the machine —
// nothing semantic exists: no vectors, no field on the results, the exact
// keyword engine. On — installed (the default since 1.16) or forced — the
// vector index is incremental (content-hash ids), survives a reload, forgets
// what leaves the index, and adds semantic_score to what it ranked. The model tests are skipped where the runtime is not installed:
// they need `npx crbro-memory semantic install` (~380 MB) and the model
// (~118 MB), which no test suite should download on its own.

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { SearchEngine } from '../src/search/index.js';
import { SemanticIndex, resolveRuntime, semanticEnabled } from '../src/search/semantic.js';

const RUNTIME = resolveRuntime() !== null;

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-sem-'));
});

afterEach(async () => {
  delete process.env.CRBRO_SEMANTIC;
  await fs.rm(root, { recursive: true, force: true });
});

async function engineWith(facts: string[]): Promise<{ engine: SearchEngine; cortex: Cortex }> {
  const brain = new Brain(root);
  await brain.initialize();
  const cortex = new Cortex(brain);
  const engine = new SearchEngine(brain);
  await engine.init();
  cortex.setIndexer(n => engine.indexNeuron(n));
  for (const f of facts) await cortex.learn('Infraestructura', 'fact', f);
  return { engine, cortex };
}

describe('off when disabled', () => {
  it('switches itself on exactly when the runtime is installed', () => {
    delete process.env.CRBRO_SEMANTIC;
    expect(semanticEnabled()).toBe(resolveRuntime() !== null);
    process.env.CRBRO_SEMANTIC = 'off';
    expect(semanticEnabled()).toBe(false);
    process.env.CRBRO_SEMANTIC = 'on';
    expect(semanticEnabled()).toBe(true);
  });

  it('holds no vectors and adds no field', async () => {
    process.env.CRBRO_SEMANTIC = '0';
    expect(semanticEnabled()).toBe(false);
    const { engine } = await engineWith(['El VPS principal es un CX32 de Hetzner en Falkenstein.']);
    expect(engine.semanticCount()).toBe(0);
    const hits = await engine.search('Hetzner');
    expect(hits[0].semantic_score).toBeUndefined();
  });
});

describe.skipIf(!RUNTIME)('with the runtime installed and CRBRO_SEMANTIC=1', () => {
  beforeAll(() => {
    process.env.CRBRO_SEMANTIC = '1';
  });

  it('embeds new lines, and only new lines', async () => {
    process.env.CRBRO_SEMANTIC = '1';
    const { engine, cortex } = await engineWith([
      'El VPS principal es un CX32 de Hetzner en Falkenstein.',
      'Cloudflare gestiona el DNS de todo el portfolio.',
    ]);
    expect(engine.semanticCount()).toBe(2);
    // Re-indexing the same neuron embeds nothing: ids are content hashes.
    await cortex.learn('Infraestructura', 'fact', 'El VPS principal es un CX32 de Hetzner en Falkenstein.');
    expect(engine.semanticCount()).toBe(2);
    await cortex.learn('Infraestructura', 'fact', 'PHP está fijado en 8.2 en todas las instancias.');
    expect(engine.semanticCount()).toBe(3);
  }, 90_000);

  // Three lines and a question that shares no word with any of them. The
  // cosines below are MEASURED, not assumed: e5-small (int8) puts the WPForms
  // line at 0.818 and the blog line at 0.803 for this query — both under the
  // production floor of 0.84, which is exactly why that floor exists. A first
  // draft of this test guessed the ordering for a different question and got
  // it backwards (0.829 vs 0.835): abstract Spanish paraphrases sit in a flat
  // 0.80–0.84 band for this model. See benchmarks/README.md.
  const LINES = [
    'El formulario es WPForms con ID 217 y despacha por SMTP de Brevo; el captcha es Turnstile.',
    'Los artículos del blog salen programados cada 3 días con imagen WebP.',
    'PHP está fijado en 8.2 en todas las instancias.',
  ];
  const NO_SHARED_WORDS = 'por qué vía entran las peticiones de presupuesto';

  it('a line the words cannot reach is ranked through the vectors', async () => {
    process.env.CRBRO_SEMANTIC = '1';
    process.env.CRBRO_SEMANTIC_FLOOR = '0.5';   // exercise the vector-only path
    try {
      const { engine } = await engineWith(LINES);
      const hits = await engine.search(NO_SHARED_WORDS);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].matching_content).toContain('WPForms');
      expect(hits[0].semantic_score).toBeGreaterThan(0.8);
      // No lexical overlap and a cosine under 0.86: honest about it.
      expect(hits[0].confidence).toBe('weak');
    } finally {
      delete process.env.CRBRO_SEMANTIC_FLOOR;
    }
  }, 90_000);

  it('the default floor drops vector-only candidates the model is not sure about', async () => {
    process.env.CRBRO_SEMANTIC = '1';
    const { engine } = await engineWith(LINES);
    // Same question, default floor: every cosine sits under 0.84, so a
    // keyword miss stays a miss instead of becoming a confident wrong answer.
    const hits = await engine.search(NO_SHARED_WORDS);
    expect(hits).toEqual([]);
  }, 90_000);

  it('vectors survive a reload and follow a forget', async () => {
    process.env.CRBRO_SEMANTIC = '1';
    const { engine, cortex } = await engineWith([
      'El VPS principal es un CX32 de Hetzner en Falkenstein.',
      'Cloudflare gestiona el DNS de todo el portfolio.',
    ]);
    await engine.persist();

    const again = new SemanticIndex(path.dirname(new Brain(root).paths.chunksIndex()));
    await again.load();
    expect(again.count()).toBe(2);

    await cortex.forget('Infraestructura', ['Cloudflare gestiona el DNS de todo el portfolio.']);
    expect(engine.semanticCount()).toBe(1);
  }, 90_000);
});
