// ─── An index that catches up instead of starting over (2.5) ─────
//
// crbro_boot calls init() on every boot. While one process served one
// conversation that was harmless; a daemon serving every client would reload
// or rebuild a 40 MB index each time anyone opened a chat. So a loaded index
// now catches up with the files that changed — which is also how the writes
// of ANOTHER process reach it, and how the one hole the mtime check had
// (a write inside its one-second slack, lost to a hard kill) gets closed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { SearchEngine } from '../src/search/index.js';

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

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-refresh-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('SearchEngine.init() on an index that is already loaded', () => {
  it('sees what another process wrote, without rebuilding', async () => {
    const a = await mk();
    await a.engine.init();
    await a.cortex.learn('Propio', 'fact', 'Un hecho escrito por este mismo proceso sobre el despliegue.');

    // "Another process": its own engines over the same folder.
    const b = await mk();
    await b.engine.init();
    await b.cortex.learn('Ajeno', 'fact', 'El certificado del balanceador caduca en marzo.');
    await b.engine.persist();

    expect(await a.engine.search('certificado balanceador')).toEqual([]);       // A has not looked yet
    let rebuilt = 0;
    const original = a.engine.rebuild.bind(a.engine);
    a.engine.rebuild = async () => { rebuilt++; return original(); };
    await a.engine.init();                                                        // what every crbro_boot does
    expect(rebuilt).toBe(0);
    expect((await a.engine.search('certificado balanceador'))[0].matching_content).toContain('caduca en marzo');
    expect((await a.engine.search('hecho escrito mismo proceso'))[0].name).toBe('Propio');
  });

  it('drops what another process deleted', async () => {
    const a = await mk();
    await a.engine.init();
    const r = await a.cortex.learn('Efímero', 'fact', 'Esta neurona la borrará otro proceso enseguida.');
    expect((await a.engine.search('borrará otro proceso'))[0].name).toBe('Efímero');

    await fs.rm(a.brain.paths.neuron(r.neuron!.id));
    const { removed } = await a.engine.refresh();
    expect(removed).toBe(1);
    expect(await a.engine.search('borrará otro proceso')).toEqual([]);
  });

  it('two boots at once load the index once', async () => {
    const seed = await mk();
    await seed.engine.init();
    await seed.cortex.learn('Semilla', 'fact', 'Para que haya un índice en disco que cargar.');
    await seed.engine.persist();

    const a = await mk();
    let loads = 0;
    const original = (a.engine as any).loadOrRebuild.bind(a.engine);
    (a.engine as any).loadOrRebuild = async () => { loads++; return original(); };
    await Promise.all([a.engine.init(), a.engine.init(), a.engine.init()]);
    expect(loads).toBe(1);
  });
});

describe('a freshly loaded index catches up from its own file date', () => {
  it('finds a neuron written inside the one-second slack and never flushed (a process killed mid-debounce)', async () => {
    const a = await mk();
    await a.engine.init();
    await a.cortex.learn('Base', 'fact', 'Lo que ya estaba indexado y persistido.');
    await a.engine.persist();
    // Written right after the persist, by a process that then dies before its next flush.
    await a.cortex.learn('Perdido', 'fact', 'El puerto de staging es el 8443, guardado justo antes del corte.');

    const b = await mk();                // the replacement process: loads the index file from disk
    await b.engine.init();
    expect((await b.engine.search('puerto staging 8443'))[0]?.matching_content).toContain('8443');
  });
});
