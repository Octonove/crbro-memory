// ─── Shelf life between machines, and inside the cortex ──────────
//
// The new fields must merge with meaning (docs/design/staleness.md §8):
//   - `verified` travels as a `verify` op: the latest check wins, whatever
//     order the logs are replayed in, over every log and the local stamp;
//   - an explicit `shelf_life` travels on the fact op as `shelf`: the most
//     volatile explicit value wins (a needless warning costs one check, a
//     missing one a wrong answer);
//   - entry_verified is rebuilt from verify ops and pruned with the entry.
// OPS_VERSION stays 1, so a client that does not know `verify` skips it.
// And the cortex: the miner never reconfirms; moves and merges carry the
// stamps; forget prunes them.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex, unionNeuron, type Emitter } from '../src/engine/cortex.js';
import { applyOps } from '../src/sync/materialize.js';
import { decodeOps, encodeOp, entryId, OPS_VERSION, type Op } from '../src/sync/ops.js';
import { factId } from '../src/utils/hash.js';
import { createSpace, joinSpace, prepareShare, commitShare, syncSpaceNow, attachSync } from '../src/sync/space.js';
import { git, gitAvailable } from '../src/sync/git.js';
import type { Neuron } from '../src/types/index.js';

const NID = 'project_tienda';
const op = (o: Record<string, unknown>): Op => ({ v: OPS_VERSION, nid: NID, by: 'ana', at: '2026-09-10T10:00:00.000Z', ...o }) as Op;
const FACT = 'La tienda usa el puerto 8443 para el panel.';
const FID = factId(FACT);
const PATTERN = 'Antes de publicar, probar el checkout en sandbox.';

function base(): Neuron {
  return {
    id: NID, name: 'Tienda', domain: 'general', type: 'project', created: '2026-01-01T00:00:00.000Z',
    last_accessed: '2026-01-01T00:00:00.000Z', access_count: 1, heat: 0.5, summary: '',
    facts: [{ text: FACT, confidence: 1, added: '2026-01-01T00:00:00.000Z', source: 'session', id: FID, status: 'active' }],
    decisions: [], patterns: [PATTERN], preferences: [], connections: [], tags: [], errors: [], debts: [],
    entry_dates: { [entryId(PATTERN)]: '2026-01-01T00:00:00.000Z' },
  };
}

describe('team spaces: verify ops', () => {
  const v1 = op({ op: 'verify', eid: FID, ekind: 'fact', at: '2026-05-01T00:00:00.000Z', by: 'ana' });
  const v2 = op({ op: 'verify', eid: FID, ekind: 'fact', at: '2026-08-01T00:00:00.000Z', by: 'luis' });
  const e1 = op({ op: 'verify', eid: entryId(PATTERN), ekind: 'entry', at: '2026-04-01T00:00:00.000Z' });
  const e2 = op({ op: 'verify', eid: entryId(PATTERN), ekind: 'entry', at: '2026-07-01T00:00:00.000Z' });

  it('the latest check wins, in both replay orders', () => {
    const a = applyOps(base(), [v1, v2, e1, e2]).neuron;
    const b = applyOps(base(), [e2, v2, e1, v1]).neuron;
    for (const n of [a, b]) {
      expect(n.facts[0].verified).toBe('2026-08-01T00:00:00.000Z');
      expect(n.entry_verified).toEqual({ [entryId(PATTERN)]: '2026-07-01T00:00:00.000Z' });
    }
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('a newer local stamp is kept; an older one moves forward and is reported', () => {
    const local = base();
    local.facts[0].verified = '2026-09-01T00:00:00.000Z';
    const kept = applyOps(local, [v1, v2]);
    expect(kept.neuron.facts[0].verified).toBe('2026-09-01T00:00:00.000Z');
    expect(kept.report.verifications_updated).toBe(0);

    const viejo = base();
    viejo.facts[0].verified = '2026-02-01T00:00:00.000Z';
    const moved = applyOps(viejo, [v2]);
    expect(moved.neuron.facts[0].verified).toBe('2026-08-01T00:00:00.000Z');
    expect(moved.report.verifications_updated).toBe(1);
  });

  it('applying the same ops twice changes nothing', () => {
    const once = applyOps(base(), [v1, v2, e1, e2]).neuron;
    const twice = applyOps(once, [v1, v2, e1, e2]);
    expect(JSON.stringify(twice.neuron)).toBe(JSON.stringify(once));
    expect(twice.report.verifications_updated).toBe(0);
  });

  it('a verify op for a fact that arrives in another log still lands (facts first, checks after)', () => {
    const fop = op({ op: 'fact', fid: 'f_otro', text: 'El staging vive en staging.tienda.es.', conf: 1, by: 'luis', at: '2026-03-01T00:00:00.000Z' });
    const vop = op({ op: 'verify', eid: 'f_otro', ekind: 'fact', at: '2026-06-01T00:00:00.000Z' });
    for (const orden of [[fop, vop], [vop, fop]]) {
      const n = applyOps(base(), orden).neuron;
      expect(n.facts.find(f => f.id === 'f_otro')!.verified).toBe('2026-06-01T00:00:00.000Z');
    }
  });

  it('a malformed at is worth nothing, and an entry check for a removed entry is pruned', () => {
    const bad = op({ op: 'verify', eid: FID, ekind: 'fact', at: 'not a date' });
    expect(applyOps(base(), [bad]).neuron.facts[0].verified).toBeUndefined();
    const purge = op({ op: 'purge', pkind: 'pattern', key: entryId(PATTERN) });
    const n = applyOps(base(), [e2, purge]).neuron;
    expect(n.patterns).toEqual([]);
    expect(n.entry_verified).toBeUndefined();
  });

  it('a neuron nobody verified stays byte-identical to what the sync produced before', () => {
    const n = applyOps(base(), [op({ op: 'pattern', text: 'Otro patrón.' })]).neuron;
    expect('entry_verified' in n).toBe(false);
    expect('verified' in n.facts[0]).toBe(false);
  });

  it('the log line is a v1 op an older client reads and skips by kind', () => {
    const line = encodeOp(v2);
    const { ops, skipped } = decodeOps(line + '\n');
    expect(skipped).toBe(0);
    expect(ops[0]).toMatchObject({ v: 1, op: 'verify', eid: FID, ekind: 'fact' });
    expect(OPS_VERSION).toBe(1);
  });
});

describe('team spaces: shelf on the fact op', () => {
  const durable = op({ op: 'fact', fid: FID, text: FACT, conf: 1, shelf: 'durable' });
  const volatile = op({ op: 'fact', fid: FID, text: FACT, conf: 1, shelf: 'volatile', by: 'luis' });
  const sinShelf = op({ op: 'fact', fid: FID, text: FACT, conf: 1, by: 'eva' });

  it('the most volatile explicit value wins, in both orders', () => {
    for (const orden of [[durable, volatile, sinShelf], [sinShelf, volatile, durable]]) {
      const n = applyOps(base(), orden).neuron;
      expect(n.facts[0].shelf_life).toBe('volatile');
    }
  });

  it('a local explicit value is only ever made more volatile by a teammate', () => {
    const local = base();
    local.facts[0].shelf_life = 'normal';
    const r = applyOps(local, [durable]);
    expect(r.neuron.facts[0].shelf_life).toBe('normal');   // lengthening stays local
    expect(r.report.shelf_updated).toBe(0);
    const r2 = applyOps(local, [volatile]);
    expect(r2.neuron.facts[0].shelf_life).toBe('volatile');
    expect(r2.report.shelf_updated).toBe(1);
  });

  it('a new fact arrives with its explicit shelf; an unknown value is ignored', () => {
    const nuevo = op({ op: 'fact', fid: 'f_new', text: 'Plan Pro: 49 euros al mes.', conf: 1, shelf: 'volatile' });
    const raro = op({ op: 'fact', fid: 'f_raro', text: 'Algo raro.', conf: 1, shelf: 'eterno' });
    const n = applyOps(base(), [nuevo, raro]).neuron;
    expect(n.facts.find(f => f.id === 'f_new')!.shelf_life).toBe('volatile');
    expect(n.facts.find(f => f.id === 'f_raro')!.shelf_life).toBeUndefined();
  });
});

describe('cortex: what writes verified, and what carries it', () => {
  let root: string;
  let cortex: Cortex;
  let emitted: Array<{ nid: string; change: Parameters<Emitter>[1] }>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-stale-sync-'));
    const brain = new Brain(root);
    await brain.initialize();
    cortex = new Cortex(brain);
    emitted = [];
    cortex.setEmitter((nid, change) => { emitted.push({ nid, change }); });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('a session learning the same fact again stamps verified and emits a verify op; the miner never does', async () => {
    const r1 = await cortex.learn('Tienda', 'fact', FACT);
    const id = r1.neuron!.id;
    expect(r1.neuron!.facts[0].verified).toBeUndefined();
    expect(r1.shelf).toEqual({ shelf_life: 'volatile', inferred: true, reason: 'port' });

    const miner = await cortex.learn('Tienda', 'fact', FACT, { neuronId: id, source: 'miner' });
    expect(miner.reconfirmed).toBeUndefined();
    expect((await cortex.peek(id))!.facts[0].verified).toBeUndefined();
    expect(emitted.some(e => e.change.kind === 'verify')).toBe(false);

    const again = await cortex.learn('Tienda', 'fact', FACT, { neuronId: id });
    expect(again.reconfirmed).toBe(true);
    const f = (await cortex.peek(id))!.facts[0];
    expect(f.verified).toBeTruthy();
    expect(emitted.filter(e => e.change.kind === 'verify')).toEqual([
      { nid: id, change: { kind: 'verify', eid: f.id, ekind: 'fact', at: f.verified } },
    ]);
  });

  it('an explicit shelf_life travels on the fact change; an inferred one never does', async () => {
    await cortex.learn('Tienda', 'fact', 'Plan Pro: 49 euros al mes.', { shelfLife: 'volatile' });
    await cortex.learn('Tienda', 'fact', 'El puerto del panel es 8443.');
    const facts = emitted.filter(e => e.change.kind === 'fact').map(e => e.change as any);
    expect(facts[0].shelf).toBe('volatile');
    expect('shelf' in facts[1]).toBe(false);
  });

  it('a retired line is still refused, and is not reconfirmed', async () => {
    const r = await cortex.learn('Tienda', 'fact', FACT);
    await cortex.revise(r.neuron!.id, [FACT], { status: 'superseded' });
    const again = await cortex.learn('Tienda', 'fact', FACT, { neuronId: r.neuron!.id });
    expect(again.action).toBe('skipped_retired');
    expect((await cortex.peek(r.neuron!.id))!.facts[0].verified).toBeUndefined();
  });

  it('verify() stamps facts and entries, emits one op each, and refuses retired targets', async () => {
    const r = await cortex.learn('Tienda', 'fact', FACT);
    const id = r.neuron!.id;
    await cortex.learn('Tienda', 'pattern', PATTERN, { neuronId: id });
    await cortex.learn('Tienda', 'decision', 'Cobramos con Redsys.', { neuronId: id });
    await cortex.retireEntries(id, ['Cobramos con Redsys.'], { status: 'retracted' });
    emitted = [];
    const v = await cortex.verify(id, { facts: [FID, 'no existe'], entries: [PATTERN, 'Cobramos con Redsys.'] });
    expect(v.verified.sort()).toEqual([FID, entryId(PATTERN)].sort());
    expect(v.unmatched.sort()).toEqual(['Cobramos con Redsys.', 'no existe'].sort());
    expect(v.retired).toEqual([{ target: 'Cobramos con Redsys.', id: entryId('Cobramos con Redsys.'), status: 'retracted' }]);
    const n = (await cortex.peek(id))!;
    expect(n.facts[0].verified).toBeTruthy();
    expect(n.entry_verified?.[entryId(PATTERN)]).toBe(n.facts[0].verified);
    expect(emitted.map(e => (e.change as any).ekind).sort()).toEqual(['entry', 'fact']);
  });

  it('unionNeuron (merge, move, restore): the later check and the more volatile class win, sidecar pruned', () => {
    const a = base();
    a.facts[0].verified = '2026-03-01T00:00:00.000Z';
    a.facts[0].shelf_life = 'durable';
    a.entry_verified = { [entryId(PATTERN)]: '2026-02-01T00:00:00.000Z', huérfana: '2026-01-01T00:00:00.000Z' };
    const b = base();
    b.facts[0].verified = '2026-06-01T00:00:00.000Z';
    b.facts[0].shelf_life = 'volatile';
    b.entry_verified = { [entryId(PATTERN)]: '2026-05-01T00:00:00.000Z' };
    const { neuron } = unionNeuron(a, b);
    expect(neuron.facts[0].verified).toBe('2026-06-01T00:00:00.000Z');
    expect(neuron.facts[0].shelf_life).toBe('volatile');
    expect(neuron.entry_verified).toEqual({ [entryId(PATTERN)]: '2026-05-01T00:00:00.000Z' });
  });

  it('moveEntries carries the stamps with the entry; forget prunes them', async () => {
    const r = await cortex.learn('Tienda', 'fact', FACT);
    const id = r.neuron!.id;
    await cortex.learn('Tienda', 'pattern', PATTERN, { neuronId: id });
    await cortex.verify(id, { facts: [FID], entries: [PATTERN] });
    const antes = (await cortex.peek(id))!;
    const m = await cortex.moveEntries(id, [FID, PATTERN], 'Tienda Ops');
    const destino = (await cortex.peek(m.into!))!;
    expect(destino.facts[0].verified).toBe(antes.facts[0].verified);
    expect(destino.entry_verified?.[entryId(PATTERN)]).toBe(antes.entry_verified![entryId(PATTERN)]);
    expect((await cortex.peek(id))!.entry_verified).toBeUndefined();

    await cortex.forget(destino.id, [PATTERN]);
    expect((await cortex.peek(destino.id))!.entry_verified).toBeUndefined();
  });
});

// ─── End to end, through a real git repository ───────────────────

describe.skipIf(!gitAvailable())('two brains, one repository: checks and shelf travel', () => {
  let raiz: string;
  let remoto: string;
  const montar = async (dir: string) => {
    const brain = new Brain(dir);
    await brain.initialize();
    const cortex = new Cortex(brain);
    attachSync(brain, cortex);
    return { brain, cortex };
  };

  beforeEach(async () => {
    raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-stale-team-'));
    remoto = path.join(raiz, 'remoto.git');
    await fs.mkdir(remoto, { recursive: true });
    git(['init', '--bare', '-b', 'main'], remoto);
  }, 60_000);

  afterEach(async () => {
    await fs.rm(raiz, { recursive: true, force: true });
  });

  it('a share carries explicit shelf and checks; a later check from a teammate restarts my clock', async () => {
    const ana = await montar(path.join(raiz, 'ana'));
    const bruno = await montar(path.join(raiz, 'bruno'));
    const precio = 'El plan Pro de la tienda cuesta 49 euros al mes.';
    const r = await ana.cortex.learn('Tienda Equipo', 'fact', precio, { shelfLife: 'volatile' });
    const nid = r.neuron!.id;
    await ana.cortex.learn('Tienda Equipo', 'pattern', PATTERN, { neuronId: nid });
    await ana.cortex.verify(nid, { entries: [PATTERN] });

    await createSpace(ana.brain, 'equipo', remoto, 'ana');
    const prep = await prepareShare(ana.brain, ana.cortex, nid, 'equipo');
    if ('error' in prep) throw new Error(prep.error);
    await commitShare(ana.brain, ana.cortex, nid, 'equipo', prep.confirm_token!);
    await syncSpaceNow(ana.brain, ana.cortex, 'equipo');

    await joinSpace(bruno.brain, 'equipo', remoto, 'bruno');
    await syncSpaceNow(bruno.brain, bruno.cortex, 'equipo');
    const deBruno = (await bruno.cortex.peek(nid))!;
    const suyo = deBruno.facts.find(f => f.text === precio)!;
    expect(suyo.shelf_life).toBe('volatile');
    expect(suyo.verified).toBeUndefined();                    // nobody checked it yet
    const anaAntes = (await ana.cortex.peek(nid))!;
    expect(deBruno.entry_verified?.[entryId(PATTERN)]).toBe(anaAntes.entry_verified![entryId(PATTERN)]);

    // Bruno checks the price against the pricing page; Ana's clock restarts.
    await new Promise(res => setTimeout(res, 5));
    const v = await bruno.cortex.verify(nid, { facts: [precio] });
    expect(v.verified).toHaveLength(1);
    await syncSpaceNow(bruno.brain, bruno.cortex, 'equipo');
    const traido = await syncSpaceNow(ana.brain, ana.cortex, 'equipo');
    expect(traido.neurons_touched).toContain(nid);           // a lone check is a change worth persisting
    const deAna = (await ana.cortex.peek(nid))!;
    expect(deAna.facts.find(f => f.text === precio)!.verified).toBe((await bruno.cortex.peek(nid))!.facts.find(f => f.text === precio)!.verified);
  }, 120_000);
});
