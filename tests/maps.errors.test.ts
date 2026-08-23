// ─── Error ledger and system maps ────────────────────────────────
//
// Born from a real complaint: after a full working session on a system, the
// next session had to re-discover everything — which template serves what,
// which mu-plugin does what, which trap costs an hour — because the brain
// held the chronicle of what happened, not the map of how it works. And the
// mistakes made along the way were written as prose, impossible to check
// before repeating the same task.
//
// errors: an append-only ledger of "mistake + how it was corrected".
// map: ONE living document per neuron, replaced whole on every update.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { SearchEngine } from '../src/search/index.js';
import { applyOps } from '../src/sync/materialize.js';
import { entryId } from '../src/sync/ops.js';
import type { Op } from '../src/sync/ops.js';
import type { Neuron } from '../src/types/index.js';

let root: string;
let brain: Brain;
let cortex: Cortex;
let engine: SearchEngine;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-map-'));
  brain = new Brain(root);
  await brain.initialize();
  cortex = new Cortex(brain);
  engine = new SearchEngine(brain);
  await engine.init();
  cortex.setIndexer(n => engine.indexNeuron(n));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('the error ledger', () => {
  it('stores an error, finds it by search, and never duplicates it', async () => {
    const err =
      'ERROR: publiqué un post fiándome del slug enviado; WordPress guardó otro y ' +
      'los enlaces del cluster habrían dado 404. CORRECCIÓN: releer el slug real ' +
      'por REST tras crear el post y construir los enlaces con ese.';
    const r1 = await cortex.learn('WordPress', 'error', err);
    expect(r1.neuron!.errors).toContain(err);

    const r2 = await cortex.learn('WordPress', 'error', err);
    expect(r2.neuron!.errors!.filter(e => e === err)).toHaveLength(1);

    const hits = await engine.search('slug enviado cluster enlaces 404');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].matched_kind).toBe('error');
  });

  it('forget removes an error entry from neuron and index', async () => {
    const err = 'ERROR: pegué la clave sk-demo en el chat. CORRECCIÓN: rotarla y a la bóveda.';
    await cortex.learn('Claves', 'error', err);
    const res = await cortex.forget('Claves', [err]);
    expect(res.removed).toBe(1);
    const hits = await engine.search('pegué clave chat bóveda');
    expect(hits.map(h => h.matching_content).join('\n')).not.toContain('sk-demo');
  });
});

describe('a stale best chunk does not silence the neuron', () => {
  it('falls back to the next live chunk in the same recall', async () => {
    // El indice guarda las dos versiones (sin indexer no hay reindex);
    // la retirada puntua mejor por ser mas larga. Antes, el guardian
    // descartaba la neurona ENTERA y este recall devolvia cero.
    const RETIRADO =
      'La paginacion del listado de facturas esta desactivada y no fue cosa nuestra: ' +
      'la plantilla la perdio en una actualizacion del constructor de paginas.';
    const VIVO = 'La paginacion del listado de facturas la desactivamos nosotros a proposito.';
    const r = await cortex.learn('Facturacion', 'fact', RETIRADO);
    await cortex.learn('Facturacion', 'fact', VIVO);
    cortex.setIndexer(null);
    const n = await cortex.peek(r.neuron!.id);
    const id = n!.facts.find(f => f.text === RETIRADO)!.id!;
    await cortex.revise(r.neuron!.id, [id]);

    const hits = await engine.search('paginacion listado facturas desactivada');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].neuron_id).toBe(r.neuron!.id);
    expect(hits[0].matching_content).toBe(VIVO);
  });
});

describe('the living map', () => {
  const MAPA_V1 =
    'MAPA: la lista vive en /prompts-list/, la pinta la plantilla 825 con el ' +
    'widget c20189c, y el filtro de visibilidad es el mu-plugin scai-prompts-list-filter.';
  const MAPA_V2 =
    'MAPA: la lista vive en /prompts-list/, plantilla 825, widget c20189c, ' +
    'paginación de 24 en 24 servida por scai-prompts-paginacion.';

  it('a rewritten map leaves exactly one map chunk in the index', async () => {
    await cortex.setMap('SimplificaWeb', MAPA_V1);
    await cortex.setMap('SimplificaWeb', MAPA_V2);

    const neuron = await cortex.peek('project_simplificaweb');
    expect(neuron!.map!.text).toBe(MAPA_V2);

    // The old version must be unfindable — this exercises real chunk removal.
    const viejos = await engine.search('filtro visibilidad scai-prompts-list-filter');
    expect(viejos.map(h => h.matching_content).join('\n')).not.toContain('scai-prompts-list-filter');

    const nuevos = await engine.search('paginación 24 scai-prompts-paginacion');
    expect(nuevos.length).toBeGreaterThan(0);
    expect(nuevos[0].matched_kind).toBe('map');
  });

  it('recall marks every result of a mapped neuron with has_map', async () => {
    await cortex.setMap('SimplificaWeb', MAPA_V2);
    await cortex.learn('SimplificaWeb', 'fact', 'El dominio se renovó en enero por dos años.');

    const hits = await engine.search('dominio renovó enero');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].has_map).toBe(true);
  });

  it('forget can remove the map when given its exact text', async () => {
    await cortex.setMap('SimplificaWeb', MAPA_V1);
    const res = await cortex.forget('SimplificaWeb', [MAPA_V1]);
    expect(res.removed).toBe(1);
    const neuron = await cortex.peek('project_simplificaweb');
    expect(neuron!.map).toBeUndefined();
  });

  it('redacts credentials before storing the map', async () => {
    const r = await cortex.setMap(
      'SimplificaWeb',
      'MAPA: el deploy usa la clave api_key = "sk-proj-abcdef1234567890abcdef1234567890abcd" en el CI.'
    );
    expect(r.redacted.length).toBeGreaterThan(0);
    const neuron = await cortex.peek('project_simplificaweb');
    expect(neuron!.map!.text).not.toContain('sk-proj-abcdef1234567890abcdef1234567890abcd');
  });
});

describe('maps and errors travel through a space', () => {
  const base = (nid: string) => ({ v: 1, nid, by: 'ana', at: '2026-08-23T10:00:00Z' });

  it('error ops merge as a set union without duplicates', async () => {
    const nid = 'project_demo';
    const ops: Op[] = [
      { ...base(nid), op: 'error', text: 'ERROR: X. CORRECCIÓN: Y.' } as Op,
      { ...base(nid), op: 'error', text: 'ERROR: X. CORRECCIÓN: Y.' } as Op,
      { ...base(nid), by: 'luis', op: 'error', text: 'ERROR: Z. CORRECCIÓN: W.' } as Op,
    ];
    const { neuron, report } = applyOps(null, ops);
    expect(neuron.errors).toHaveLength(2);
    expect(report.errors_added).toBe(2);
  });

  it('the newest map wins, and a stale copy cannot resurrect an older one', async () => {
    const nid = 'project_demo';
    const temprano: Op = { ...base(nid), at: '2026-08-01T00:00:00Z', op: 'map', text: 'mapa viejo' } as Op;
    const tarde: Op = { ...base(nid), by: 'luis', at: '2026-08-20T00:00:00Z', op: 'map', text: 'mapa nuevo' } as Op;

    // Order of arrival must not matter.
    const a = applyOps(null, [temprano, tarde]).neuron;
    const b = applyOps(null, [tarde, temprano]).neuron;
    expect(a.map!.text).toBe('mapa nuevo');
    expect(b.map!.text).toBe('mapa nuevo');

    // Replaying the old op over a neuron that already has the new map: no-op.
    const c = applyOps(a, [temprano]).neuron;
    expect(c.map!.text).toBe('mapa nuevo');
  });

  it('a timestamp tie breaks the same way on every machine', async () => {
    const nid = 'project_demo';
    const uno: Op = { ...base(nid), op: 'map', text: 'mapa A' } as Op;
    const dos: Op = { ...base(nid), by: 'luis', op: 'map', text: 'mapa B' } as Op;
    const x = applyOps(null, [uno, dos]).neuron.map!.text;
    const y = applyOps(null, [dos, uno]).neuron.map!.text;
    expect(x).toBe(y);
  });

  it('a log line without a timestamp can never win the map', async () => {
    const nid = 'project_demo';
    const legit: Op = { ...base(nid), at: '2026-08-20T00:00:00Z', op: 'map', text: 'mapa legitimo' } as Op;
    const veneno = { v: 1, nid, by: 'mallory', op: 'map', text: 'mapa envenenado' } as unknown as Op; // sin at
    const a = applyOps(null, [legit, veneno]).neuron;
    const b = applyOps(null, [veneno, legit]).neuron;
    expect(a.map!.text).toBe('mapa legitimo');
    expect(b.map!.text).toBe('mapa legitimo');
    // Y un mapa local sin updated (neurona editada a mano) pierde contra una fecha real.
    const local = applyOps(null, [veneno]).neuron;
    const curado = applyOps(local, [legit]).neuron;
    expect(curado.map!.text).toBe('mapa legitimo');
  });

  it('an empty map op is a tombstone: clearing travels and stale copies stay dead', async () => {
    const nid = 'project_demo';
    const pone: Op = { ...base(nid), at: '2026-08-10T00:00:00Z', op: 'map', text: 'mapa vivo' } as Op;
    const borra: Op = { ...base(nid), at: '2026-08-15T00:00:00Z', op: 'map', text: '' } as Op;
    const a = applyOps(null, [pone, borra]).neuron;
    const b = applyOps(null, [borra, pone]).neuron;
    expect(a.map).toBeUndefined();
    expect(b.map).toBeUndefined();
  });

  it('a purged error never comes back, whatever the order', async () => {
    const nid = 'project_demo';
    const texto = 'ERROR: X. CORRECCION: Y.';
    const anade: Op = { ...base(nid), op: 'error', text: texto } as Op;
    const purga = { ...base(nid), at: '2026-08-25T00:00:00Z', op: 'purge', pkind: 'error',
                    key: entryId(texto) } as unknown as Op;
    const a = applyOps(null, [anade, purga]).neuron;
    const b = applyOps(null, [purga, anade]).neuron;
    expect(a.errors || []).toHaveLength(0);
    expect(b.errors || []).toHaveLength(0);
  });

  it('an op kind from the future is skipped, not fatal', async () => {
    const nid = 'project_demo';
    const ops = [
      { ...base(nid), op: 'fact', fid: 'f1', text: 'un hecho', conf: 1 },
      { ...base(nid), op: 'hologram', text: 'algo de una versión posterior' },
    ] as unknown as Op[];
    const { neuron } = applyOps(null, ops);
    expect(neuron.facts).toHaveLength(1);
  });
});

describe('setMap resolves ids like the rest of the system', () => {
  it('an exact neuron id wins over a prefix-stripped near-miss', async () => {
    // 'domain_project_octochat' sin prefijo tambien es 'project_octochat':
    // con findByName primero, el mapa acababa en la neurona equivocada y la
    // lectura (peek primero) respondia que no habia mapa.
    await cortex.create('project octochat', 'domain', 'general');
    await cortex.create('octochat', 'project', 'general');

    const r = await cortex.setMap('project_octochat', 'MAPA: el de verdad.');
    expect(r.neuron!.id).toBe('project_octochat');

    const leida = await cortex.peek('project_octochat');
    expect(leida!.map!.text).toBe('MAPA: el de verdad.');
    const otra = await cortex.peek('domain_project_octochat');
    expect(otra!.map).toBeUndefined();
  });
});

describe('setMap creates the neuron when needed', () => {
  it('writing a map to an unknown topic creates its neuron', async () => {
    const r = await cortex.setMap('Sistema Nuevo', 'MAPA: vive en /opt/nuevo y lo sirve systemd.');
    expect(r.action).toBe('created');
    const otra = await cortex.setMap('Sistema Nuevo', 'MAPA: vive en /opt/nuevo, systemd, puerto 8080.');
    expect(otra.action).toBe('updated');
    const neuron = await cortex.peek(r.neuron!.id) as Neuron;
    expect(neuron.map!.text).toContain('8080');
  });
});
