// ─── The index between processes (2.11) ──────────────────────────
//
// Three holes in how the index lived on disk:
//  - B7: an index merely older than one neuron (a plain read rewrites a
//    neuron) was rebuilt from scratch at boot instead of loaded and caught up.
//  - B8: a long-lived process never saw what another one learned after its
//    boot, and its next write put its older view over the other's index.
//  - A10: in classic mode a dirty index was written only by a 5 s timer that
//    does not keep the process alive.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { SearchEngine, flushOnExit } from '../src/search/index.js';

let root: string;
const mk = async () => {
  const brain = new Brain(root);
  await brain.initialize();
  const cortex = new Cortex(brain);
  const engine = new SearchEngine(brain);
  cortex.setIndexer(n => engine.indexNeuron(n));
  cortex.setRemover(id => engine.removeNeuron(id));
  return { brain, cortex, engine };
};

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-life-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); });

describe('B7: a stale index is loaded and refreshed, not rebuilt', () => {
  it('boots without a rebuild when one neuron is newer than the index, and finds it', async () => {
    const a = await mk();
    await a.engine.init();
    await a.cortex.learn('Viejo', 'fact', 'Un dato ya indexado sobre el balanceador.');
    await a.engine.persist();
    // Another process writes a neuron later and dies before writing the index.
    const later = await mk();
    await later.engine.init();
    await later.cortex.learn('Nuevo', 'fact', 'El certificado del proxy inverso caduca en abril.');
    const file = later.brain.paths.neuron('project_nuevo');
    const future = new Date(Date.now() + 10_000);
    await fs.utimes(file, future, future);

    const b = await mk();
    let rebuilt = 0;
    const original = b.engine.rebuild.bind(b.engine);
    b.engine.rebuild = async () => { rebuilt++; return original(); };
    await b.engine.init();
    expect(rebuilt).toBe(0);
    expect((await b.engine.search('certificado proxy inverso'))[0]?.name).toBe('Nuevo');
    expect((await b.engine.search('balanceador'))[0]?.name).toBe('Viejo');
  });

  it('still rebuilds an index of another version', async () => {
    const a = await mk();
    await a.engine.init();
    await a.cortex.learn('Uno', 'fact', 'Algo que indexar.');
    await a.engine.persist();
    const file = a.brain.paths.chunksIndex();
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    stored.v = 7;
    await fs.writeFile(file, JSON.stringify(stored));
    const b = await mk();
    let rebuilt = 0;
    const original = b.engine.rebuild.bind(b.engine);
    b.engine.rebuild = async () => { rebuilt++; return original(); };
    await b.engine.init();
    expect(rebuilt).toBe(1);
  });
});

describe('B8: two live processes over one brain', () => {
  it('a search sees what another process learned after this one booted', async () => {
    const a = await mk();
    await a.engine.init();
    await a.cortex.learn('Propio', 'fact', 'Lo que sabe el proceso A desde el principio.');
    const b = await mk();
    await b.engine.init();
    await b.cortex.learn('Ajeno', 'fact', 'El túnel de staging escucha en el puerto 7443.');
    // No boot, no init: just a search in A.
    expect((await a.engine.search('túnel staging 7443'))[0]?.name).toBe('Ajeno');
  });

  it('a revision by another process replaces the old line in this one', async () => {
    const a = await mk();
    await a.engine.init();
    await a.cortex.learn('Infra', 'fact', 'El puerto del panel de control es el 8080.');
    expect((await a.engine.search('puerto panel control'))[0]?.matching_content).toContain('8080');
    // B rewrites the neuron file directly (another tool, another machine syncing).
    const file = a.brain.paths.neuron('project_infra');
    const n = JSON.parse(await fs.readFile(file, 'utf8'));
    n.facts.push({ text: 'El puerto del panel de control pasó al 9090 en noviembre.', confidence: 1, added: new Date().toISOString(), source: 'manual' });
    await new Promise(r => setTimeout(r, 20));
    await fs.writeFile(file + '.tmp', JSON.stringify(n));
    await fs.rename(file + '.tmp', file);
    const hits = await a.engine.search('panel control 9090');
    expect(hits[0]?.matching_content).toContain('9090');
  });

  it('a later write of an older view never hides the newer neuron from the next boot', async () => {
    const a = await mk();
    await a.engine.init();
    await a.cortex.learn('Visto', 'fact', 'Lo que el proceso A tenía en su índice.');
    const b = await mk();
    await b.engine.init();
    await b.cortex.learn('Visto', 'fact', 'Una segunda línea que solo conoce el proceso B sobre el cifrado.');
    await b.engine.persist();
    await new Promise(r => setTimeout(r, 1100));
    await a.engine.persist();                       // A writes last
    const c = await mk();
    await c.engine.init();
    expect((await c.engine.search('segunda línea cifrado'))[0]?.matching_content).toContain('cifrado');
  });

  it('records the file date of every neuron it indexed', async () => {
    const a = await mk();
    await a.engine.init();
    await a.cortex.learn('Fechado', 'fact', 'Una línea para fechar.');
    await a.engine.persist();
    const stored = JSON.parse(await fs.readFile(a.brain.paths.chunksIndex(), 'utf8'));
    const st = await fs.stat(a.brain.paths.neuron('project_fechado'));
    expect(stored.mtimes.project_fechado).toBe(st.mtimeMs);
  });
});

describe('A10: classic mode writes a dirty index before leaving', () => {
  it('flushes on stdin end and exits within the deadline', async () => {
    const a = await mk();
    await a.engine.init();
    await a.engine.persist();
    await a.cortex.learn('Último', 'fact', 'Guardado justo antes de que el cliente cerrara la tubería.');
    expect(a.engine.isDirty()).toBe(true);
    const input = new EventEmitter();
    let code: number | null = null;
    const done = new Promise<void>(resolve => {
      const off = flushOnExit(a.engine, { input: input as any, exit: c => { code = c; off(); resolve(); }, signals: false });
    });
    const t0 = Date.now();
    input.emit('end');
    await done;
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(a.engine.isDirty()).toBe(false);
    const b = await mk();
    await b.engine.init();
    expect((await b.engine.search('cliente cerrara tubería'))[0]?.name).toBe('Último');
  });

  it('leaves at the deadline even if the write hangs', async () => {
    const input = new EventEmitter();
    let code: number | null = null;
    const hung = { flush: () => new Promise<void>(() => undefined), flushSync: () => undefined };
    const t0 = Date.now();
    await new Promise<void>(resolve => {
      const off = flushOnExit(hung, { input: input as any, exit: c => { code = c; off(); resolve(); }, signals: false });
      input.emit('close');
    });
    expect(code).toBe(0);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(1900);
    expect(took).toBeLessThan(3000);
  });

  it('writes synchronously on a plain exit', async () => {
    const a = await mk();
    await a.engine.init();
    await a.engine.persist();
    await a.cortex.learn('Síncrono', 'fact', 'Escrito por el manejador de exit.');
    a.engine.flushSync();
    expect(a.engine.isDirty()).toBe(false);
    const stored = JSON.parse(await fs.readFile(a.brain.paths.chunksIndex(), 'utf8'));
    expect(JSON.stringify(stored.data)).toContain('manejador de exit');
  });
});
