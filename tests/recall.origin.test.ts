// ─── P4 (2.7): where a recalled line came from ───────────────────
//
// A shared space, the miner and a bulk import all put lines in the brain that
// the user never wrote. Recall served them exactly like the user's own, so a
// teammate's guess read as the user's decision. Each result now says where it
// came from — but only when it is NOT the user's own, so the common case
// costs no token at all. The origin is read from what the entry already
// carries (a fact's source, a decision's or map's `by`) and, for patterns,
// errors and debts, from the entry_source sidecar the sync now fills.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex, unionNeuron } from '../src/engine/cortex.js';
import { SearchEngine } from '../src/search/index.js';
import { applyOps } from '../src/sync/materialize.js';
import { entryId, OPS_VERSION, type Op } from '../src/sync/ops.js';

let root: string;
let brain: Brain;
let cortex: Cortex;
let engine: SearchEngine;

const NID = 'project_tienda';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-origin-'));
  process.env.CRBRO_SEMANTIC = '0';
  brain = new Brain(root);
  await brain.initialize();
  cortex = new Cortex(brain);
  engine = new SearchEngine(brain);
  await engine.init();
  cortex.setIndexer(n => engine.indexNeuron(n));
  // This machine is "yo", and the neuron is shared in the space "equipo".
  await fs.writeFile(path.join(root, 'identity.json'), JSON.stringify({ author: 'yo', device: 'abc123' }));
  await fs.writeFile(path.join(root, 'shared-map.json'), JSON.stringify({ [NID]: 'equipo' }));
});

afterEach(async () => {
  delete process.env.CRBRO_SEMANTIC;
  await fs.rm(root, { recursive: true, force: true });
});

const op = (o: Record<string, unknown>): Op => ({ v: OPS_VERSION, nid: NID, at: '2026-09-10T10:00:00Z', ...o }) as Op;

async function sync(ops: Op[]): Promise<void> {
  const local = await cortex.peek(NID);
  const { neuron } = applyOps(local, ops, { id: NID });
  await cortex.replaceFromSync(neuron);
}

const top = async (q: string) => (await engine.search(q, { limit: 3 }))[0];

describe('recall origin', () => {
  it('says nothing about the user\'s own lines', async () => {
    await cortex.learn('Tienda', 'fact', 'El checkout de la tienda usa pasarela redsys con tres reintentos.', { neuronId: NID });
    await cortex.learn('Tienda', 'pattern', 'Probar el checkout redsys en sandbox antes de publicar.', { neuronId: NID });
    const r = await top('checkout redsys reintentos');
    expect(r.neuron_id).toBe(NID);
    expect(r).not.toHaveProperty('origin');
    expect(r).not.toHaveProperty('by');
  });

  it('marks a teammate\'s fact, pattern, error, decision and map with the space and the author', async () => {
    await cortex.learn('Tienda', 'fact', 'Una linea propia para que la neurona exista en local.', { neuronId: NID });
    await sync([
      op({ op: 'fact', by: 'ana', fid: 'f-ana', text: 'El almacen sincroniza stock cada quince minutos por cron.', conf: 1 }),
      op({ op: 'pattern', by: 'bruno', text: 'Vaciar la cola de pedidos huerfanos los lunes temprano.' }),
      op({ op: 'error', by: 'ana', text: 'Subir precios sin IVA rompio las facturas rectificativas; se corrigio recalculando.' }),
      op({ op: 'decision', by: 'bruno', did: entryId('Envios gratis desde cincuenta euros'), text: 'Envios gratis desde cincuenta euros', why: 'ticket medio' }),
      op({ op: 'map', by: 'ana', text: 'Mapa: la tienda vive en el servidor kestrel con base mariadb y colas rabbit.' }),
    ]);

    const casos: Array<[string, string]> = [
      ['almacen stock quince minutos', 'ana'],
      ['cola pedidos huerfanos lunes', 'bruno'],
      ['precios IVA facturas rectificativas', 'ana'],
      ['envios gratis cincuenta euros', 'bruno'],
      ['kestrel mariadb rabbit', 'ana'],
    ];
    for (const [q, autor] of casos) {
      const r = await top(q);
      expect(r.neuron_id, q).toBe(NID);
      expect(r.origin, q).toBe('team:equipo');
      expect(r.by, q).toBe(autor);
    }
  });

  it('keeps the mark on a synced line signed with this machine\'s own name: `by` can be forged', async () => {
    await cortex.learn('Tienda', 'fact', 'Linea local de arranque.', { neuronId: NID });
    await sync([op({ op: 'pattern', by: 'yo', text: 'Revisar los logs del webhook de pagos cada viernes.' })]);
    const r = await top('logs webhook pagos viernes');
    expect(r.neuron_id).toBe(NID);
    expect(r.origin).toBe('team:equipo');
    expect(r.by).toBe('yo');
  });

  it('marks a teammate\'s line in also_matched when the user\'s own line wins', async () => {
    await cortex.learn('Tienda', 'fact', 'El checkout de la tienda usa la pasarela redsys con tres reintentos.', { neuronId: NID });
    await sync([op({ op: 'pattern', by: 'ana', text: 'Desactivar los reintentos del checkout redsys los viernes.' })]);
    const r = await top('checkout redsys tres reintentos pasarela');
    expect(r.neuron_id).toBe(NID);
    expect(r).not.toHaveProperty('origin');
    const ajena = (r.also_matched || []).find(a => a.preview.startsWith('Desactivar'));
    expect(ajena, JSON.stringify(r.also_matched)).toBeDefined();
    expect(ajena!.origin).toBe('team:equipo');
    expect(ajena!.by).toBe('ana');
  });

  it('marks the miner and a bulk import', async () => {
    await cortex.learn('Tienda', 'fact', 'Linea propia de la tienda.', { neuronId: NID });
    await cortex.learn('Tienda', 'fact', 'El tema de la tienda se llama aurora y viene de themeforest.', { neuronId: NID, source: 'miner' });
    await cortex.learn('Tienda', 'decision', 'Migrar las fichas de producto a bloques gutenberg.', { neuronId: NID, source: 'miner' });
    await cortex.learn('Tienda', 'fact', 'El catalogo antiguo tenia ochocientas referencias descatalogadas.', { neuronId: NID, source: 'import' });
    expect((await top('tema aurora themeforest')).origin).toBe('miner');
    expect((await top('fichas producto bloques gutenberg')).origin).toBe('miner');
    expect((await top('catalogo antiguo referencias descatalogadas')).origin).toBe('import');
  });

  it('says "team" without a space when the neuron is no longer in the shared map', async () => {
    await fs.writeFile(path.join(root, 'shared-map.json'), JSON.stringify({}));
    await cortex.learn('Tienda', 'fact', 'Linea local.', { neuronId: NID });
    await sync([op({ op: 'pattern', by: 'ana', text: 'Cerrar la caja registradora virtual a medianoche.' })]);
    const r = await top('caja registradora medianoche');
    expect(r.origin).toBe('team');
    expect(r.by).toBe('ana');
  });

  it('works on a brain with no identity, no shared map and no entry_source at all', async () => {
    await fs.rm(path.join(root, 'identity.json'));
    await fs.rm(path.join(root, 'shared-map.json'));
    await cortex.learn('Tienda', 'pattern', 'Comprobar el certificado del dominio cada trimestre.', { neuronId: NID });
    const n = await cortex.peek(NID);
    expect(n).not.toHaveProperty('entry_source');
    const r = await top('certificado dominio trimestre');
    expect(r).not.toHaveProperty('origin');
  });
});

describe('entry_source sidecar', () => {
  it('records the teammate only for entries the replay adds, the same whatever the log order', () => {
    const local = applyOps(null, [op({ op: 'neuron', by: 'yo', name: 'Tienda', domain: 'general', ntype: 'project' })], { id: NID }).neuron;
    local.patterns.push('Patron que ya estaba aqui');
    const ops = [
      op({ op: 'pattern', by: 'bruno', at: '2026-09-11T00:00:00Z', text: 'Patron compartido' }),
      op({ op: 'pattern', by: 'ana', at: '2026-09-10T00:00:00Z', text: 'Patron compartido' }),
      op({ op: 'pattern', by: 'carla', text: 'Patron que ya estaba aqui' }),
    ];
    const a = applyOps(local, ops, { id: NID }).neuron;
    const b = applyOps(local, [...ops].reverse(), { id: NID }).neuron;
    expect(a.entry_source).toEqual({ [entryId('Patron compartido')]: 'team:ana' });
    expect(b.entry_source).toEqual(a.entry_source);
  });

  it('is cleared when the same line is learned here, and kept through a merge', async () => {
    const texto = 'Un error que trajo el minero de un transcript.';
    await cortex.learn('Tienda', 'error', texto, { neuronId: NID, source: 'miner' });
    let n = (await cortex.peek(NID))!;
    expect(n.entry_source).toEqual({ [entryId(texto)]: 'miner' });

    // A merge keeps it (pruned to what is still there).
    const otra = { ...n, id: 'project_otra' };
    const sinNada = { ...n, errors: [], entry_source: undefined };
    expect(unionNeuron(sinNada, otra).neuron.entry_source).toEqual({ [entryId(texto)]: 'miner' });

    // Forgotten: the key goes with the line, so the sidecar never outlives it.
    await cortex.forget(NID, [texto]);
    expect((await cortex.peek(NID))!.entry_source).toBeUndefined();
    // Then learned by this session: it is the user's own now.
    await cortex.learn('Tienda', 'error', texto, { neuronId: NID });
    n = (await cortex.peek(NID))!;
    expect(n.errors).toContain(texto);
    expect(n.entry_source?.[entryId(texto)]).toBeUndefined();
  });
});
