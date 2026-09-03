// ─── The 2.0 engine additions, exercised directly ─────────────────
//
// surface2.test.ts checks the tools through MCP. This file goes one layer
// down, to the engine methods the server composes: the sync ops that a
// forget of decisions/patterns now emits, the purity of unionNeuron, what
// rewire does with the three kinds of synapse it meets, the context that
// stops rewriting itself on reads, session logs that redact and can be
// audited or forgotten, retired entries leaving the index, and the archive
// round trip. Where the server adds nothing, testing here is both faster
// and more precise.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex, unionNeuron } from '../src/engine/cortex.js';
import { Synapses } from '../src/engine/synapses.js';
import { HeatEngine } from '../src/engine/heat.js';
import { Hippocampus } from '../src/engine/hippocampus.js';
import { Prefrontal } from '../src/engine/prefrontal.js';
import { SearchEngine, INDEX_VERSION } from '../src/search/index.js';
import { Maintenance } from '../src/engine/maintenance.js';
import { entryId } from '../src/sync/ops.js';
import { synapseId } from '../src/utils/ids.js';
import type { Neuron } from '../src/types/index.js';

let root: string;
let brain: Brain;
let cortex: Cortex;

const build = () => {
  const synapses = new Synapses(brain);
  const heat = new HeatEngine(brain);
  const hippocampus = new Hippocampus(brain);
  const prefrontal = new Prefrontal(brain);
  const search = new SearchEngine(brain);
  const maintenance = new Maintenance(brain, cortex, synapses, heat, hippocampus, prefrontal, search);
  return { synapses, heat, hippocampus, prefrontal, search, maintenance };
};

const readNeuron = async (id: string): Promise<Neuron> =>
  JSON.parse(await fs.readFile(brain.paths.neuron(id), 'utf-8'));

/** A minimal neuron literal for the pure-function tests. */
const bare = (id: string, extra: Partial<Neuron> = {}): Neuron => ({
  id, name: id, domain: 'general', type: 'project',
  created: '2026-01-01T00:00:00.000Z', last_accessed: '2026-01-01T00:00:00.000Z',
  access_count: 1, heat: 0.1, summary: '',
  facts: [], decisions: [], patterns: [], preferences: [], connections: [], tags: [],
  ...extra,
} as Neuron);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-life2-'));
  brain = new Brain(root);
  await brain.initialize();
  cortex = new Cortex(brain);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════
describe('Cortex.forget emits purge ops for decisions and patterns and prunes entry_status', () => {
  it('one decision_purge / pattern_purge per removed entry, keyed by entryId', async () => {
    const events: any[] = [];
    cortex.setEmitter((_id, change) => { events.push(change); });

    const decision = 'Usamos colas para el correo saliente.';
    const pattern = 'Validar en el servidor, siempre.';
    const error = 'ERROR: indice olvidado. FIX: crearlo.';
    const { neuron } = await cortex.learn('Purga', 'decision', decision);
    await cortex.learn('Purga', 'pattern', pattern);
    await cortex.learn('Purga', 'error', error);
    await cortex.learn('Purga', 'pattern', 'Un patron que se queda.');
    await cortex.retireEntries(neuron!.id, [decision, pattern]);
    expect(Object.keys((await readNeuron(neuron!.id)).entry_status!)).toHaveLength(2);
    events.length = 0;

    const r = await cortex.forget(neuron!.id, [decision, pattern.toUpperCase(), error]);
    expect(r.removed).toBe(3);
    expect(r.backup).toBeTruthy();

    const kinds = events.map(e => e.kind).sort();
    expect(kinds).toEqual(['decision_purge', 'error_purge', 'pattern_purge']);
    expect(events.find(e => e.kind === 'decision_purge').key).toBe(entryId(decision));
    expect(events.find(e => e.kind === 'pattern_purge').key).toBe(entryId(pattern));
    expect(events.find(e => e.kind === 'error_purge').key).toBe(entryId(error));
    for (const e of events) expect(e.at).toBeTruthy();

    const after = await readNeuron(neuron!.id);
    expect(after.decisions).toEqual([]);
    expect(after.patterns).toEqual(['Un patron que se queda.']);
    expect(after.entry_status).toBeUndefined();                  // both retired keys pruned with their entries
    expect(Object.keys(after.entry_dates || {})).toEqual([entryId('Un patron que se queda.')]);
  });

  it('emits nothing when nothing matched', async () => {
    const events: any[] = [];
    cortex.setEmitter((_id, change) => { events.push(change); });
    const { neuron } = await cortex.learn('Purga Vacia', 'fact', 'Algo.');
    events.length = 0;                                   // the learn itself emitted a 'fact' op
    const r = await cortex.forget(neuron!.id, ['no existe']);
    expect(r.removed).toBe(0);
    expect(r.backup).toBeNull();
    expect(events).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('Cortex.list offset and retireEntries / setMeta edge cases', () => {
  it('offset applies after the heat sort and before limit; facts_count counts retired facts too', async () => {
    for (let i = 0; i < 4; i++) await cortex.learn(`Lista ${i}`, 'fact', `Hecho de la lista ${i}.`);
    const { neuron } = await cortex.learn('Lista 0', 'fact', 'Segundo hecho de la lista cero.');
    await cortex.revise(neuron!.id, ['Segundo hecho de la lista cero.']);

    const all = await cortex.list();
    expect(all).toHaveLength(4);
    expect(all.find(n => n.id === neuron!.id)!.facts_count).toBe(2);
    const paged = await cortex.list({ limit: 2, offset: 1 });
    expect(paged.map(n => n.id)).toEqual(all.slice(1, 3).map(n => n.id));
    expect(await cortex.list({ offset: 10 })).toEqual([]);
  });

  it('retireEntries: default status superseded, active only matches retired, unknown neuron echoes targets', async () => {
    const debt = 'DEFERRED: cache. CEILING: 2s. REVISIT WHEN: p95 > 1s.';
    const { neuron } = await cortex.learn('Deuda', 'debt', debt);
    const first = await cortex.retireEntries(neuron!.id, [`  ${debt.toUpperCase()}  `]);
    expect(first.revised).toBe(1);
    expect(first.unmatched).toEqual([]);
    const st = (await readNeuron(neuron!.id)).entry_status![entryId(debt)];
    expect(st.status).toBe('superseded');
    expect(st.note).toBeUndefined();

    const noop = await cortex.retireEntries(neuron!.id, [debt], { status: 'retracted' });
    expect(noop.revised).toBe(0);
    expect(noop.unmatched).toEqual([debt]);

    const back = await cortex.retireEntries('Deuda', [debt], { status: 'active' });
    expect(back.revised).toBe(1);
    expect((await readNeuron(neuron!.id)).entry_status).toBeUndefined();

    const nobody = await cortex.retireEntries('nadie', ['x', 'y']);
    expect(nobody).toEqual({ neuron: null, revised: 0, unmatched: ['x', 'y'] });
  });

  it('setMeta writes only what differs, and empty strings for domain and name are ignored', async () => {
    const { neuron } = await cortex.learn('Meta', 'fact', 'Neurona con metadatos.');
    const before = (await fs.stat(brain.paths.neuron(neuron!.id))).mtimeMs;
    await new Promise(r => setTimeout(r, 20));

    const none = await cortex.setMeta(neuron!.id, { domain: '', name: '   ', tags: [] });
    expect(none.changed).toEqual([]);
    expect((await fs.stat(brain.paths.neuron(neuron!.id))).mtimeMs).toBe(before);

    const some = await cortex.setMeta(neuron!.id, { domain: 'infra', tags: ['a', 'b', 'a'] });
    expect(some.changed.sort()).toEqual(['domain', 'tags']);
    const n = await readNeuron(neuron!.id);
    expect(n.domain).toBe('infra');
    expect(n.tags).toEqual(['a', 'b']);
    expect(n.id).toBe(neuron!.id);

    expect(await cortex.setMeta('nadie', { summary: 'x' })).toEqual({ neuron: null, changed: [], redacted: [] });
  });

  it('revise with an empty target list resolves the neuron and revises nothing', async () => {
    const { neuron } = await cortex.learn('Vacio', 'fact', 'Un hecho.');
    const r = await cortex.revise(neuron!.id, [], { status: 'active' });
    expect(r.neuron?.id).toBe(neuron!.id);
    expect(r.revised).toBe(0);
    expect(r.unmatched).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('unionNeuron is pure and merges the way the contract says', () => {
  it('does not mutate its inputs and counts only what actually moved', () => {
    const shared = 'La API escucha en 8080.';
    const target = bare('project_target', {
      facts: [{ text: shared, confidence: 1, added: '2026-03-01T00:00:00.000Z', source: 'session', status: 'active', keys: ['api'] }],
      decisions: [{ text: 'Decision A', rationale: 'target says so', date: '2026-03-01T00:00:00.000Z' } as any],
      patterns: ['Patron comun'],
      tags: ['t1'],
      connections: ['project_x', 'project_source'],
      heat: 0.2, access_count: 3, summary: '',
      map: { text: 'mapa del target', updated: '2026-03-01T00:00:00.000Z' },
    });
    const source = bare('project_source', {
      facts: [
        // Same wording, stray double space: normalizeText lines them up (case is NOT folded here).
        { text: shared.replace(' en ', '  en '), confidence: 0.5, added: '2026-01-15T00:00:00.000Z', source: 'session', status: 'superseded', revision_note: 'old', keys: ['puerto'] },
        { text: 'Hecho solo del source.', confidence: 1, added: '2026-02-01T00:00:00.000Z', source: 'session', status: 'active' },
      ],
      decisions: [{ text: 'Decision  A', rationale: 'source says otherwise', date: '2026-02-01T00:00:00.000Z' } as any, { text: 'Decision B', date: '2026-02-02T00:00:00.000Z' } as any],
      patterns: [' Patron comun ', 'Patron nuevo'],
      preferences: ['Prefiere tabs'],
      errors: ['ERROR: x. FIX: y.'],
      debts: ['DEFERRED: z.'],
      tags: ['t1', 't2'],
      connections: ['project_target', 'project_y'],
      heat: 0.7, access_count: 5, summary: 'resumen del source',
      map: { text: 'mapa del source', updated: '2026-02-01T00:00:00.000Z' },
      created: '2025-12-01T00:00:00.000Z',
    });
    const snapT = JSON.stringify(target);
    const snapS = JSON.stringify(source);

    const { neuron, moved } = unionNeuron(target, source);

    expect(JSON.stringify(target)).toBe(snapT);
    expect(JSON.stringify(source)).toBe(snapS);
    expect(neuron).not.toBe(target);

    expect(moved).toEqual({ facts: 1, decisions: 1, patterns: 1, preferences: 1, errors: 1, debts: 1, tags: 1, map: 0 });
    expect(neuron.id).toBe('project_target');
    expect(neuron.facts).toHaveLength(2);
    const hit = neuron.facts.find(f => f.text === shared)!;
    expect(hit.text).toBe(shared);                                  // target's telling stays
    expect(hit.status).toBe('superseded');                          // furthest-along status wins
    expect(hit.revision_note).toBe('old');
    expect(hit.added).toBe('2026-01-15T00:00:00.000Z');             // earliest added
    expect(hit.keys).toEqual(['api', 'puerto']);                    // keys unioned
    expect(neuron.decisions.find(d => d.text === 'Decision A')!.rationale).toBe('target says so');
    expect(neuron.decisions.map(d => d.text)).toEqual(['Decision A', 'Decision B']);
    expect(neuron.patterns).toEqual(['Patron comun', 'Patron nuevo']);
    expect(neuron.tags).toEqual(['t1', 't2']);
    expect(neuron.connections).toEqual(['project_x', 'project_y']); // neither id survives
    expect(neuron.summary).toBe('resumen del source');              // target's was empty
    expect(neuron.heat).toBe(0.7);
    expect(neuron.access_count).toBe(8);
    expect(neuron.created).toBe('2025-12-01T00:00:00.000Z');
    expect(neuron.map!.text).toBe('mapa del target');
    expect(neuron.entry_dates).toEqual({});
    expect(neuron.entry_status).toBeUndefined();
  });

  it('takes the source map when the target has none, and prunes sidecars to live entries', () => {
    const target = bare('project_t', {
      patterns: ['vivo'],
      entry_dates: { [entryId('vivo')]: '2026-02-01T00:00:00.000Z', [entryId('muerto')]: '2026-01-01T00:00:00.000Z' },
      entry_status: { [entryId('muerto')]: { status: 'retracted', revised: '2026-01-02T00:00:00.000Z' } },
    });
    const source = bare('project_s', {
      patterns: ['vivo', 'otro'],
      entry_dates: { [entryId('vivo')]: '2026-01-01T00:00:00.000Z', [entryId('otro')]: '2026-01-03T00:00:00.000Z' },
      entry_status: { [entryId('otro')]: { status: 'superseded', revised: '2026-01-04T00:00:00.000Z', note: 'n' } },
      map: { text: 'solo el source tiene mapa', updated: '2026-01-01T00:00:00.000Z' },
    });
    const { neuron, moved } = unionNeuron(target, source);
    expect(moved.map).toBe(1);
    expect(moved.patterns).toBe(1);
    expect(neuron.map!.text).toBe('solo el source tiene mapa');
    expect(neuron.entry_dates).toEqual({
      [entryId('otro')]: '2026-01-03T00:00:00.000Z',
      [entryId('vivo')]: '2026-01-01T00:00:00.000Z',               // earliest wins
    });
    expect(neuron.entry_status).toEqual({ [entryId('otro')]: { status: 'superseded', revised: '2026-01-04T00:00:00.000Z', note: 'n' } });
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('Synapses: setStrength, removeAllFor, rewire', () => {
  const four = async () => {
    const ids: string[] = [];
    for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta']) {
      ids.push((await cortex.learn(name, 'fact', `Neurona ${name}.`)).neuron!.id);
    }
    return ids;
  };

  it('setStrength changes the strength only, clamps and rounds, and never creates', async () => {
    const [a, b] = await four();
    const { synapses } = build();
    expect(await synapses.setStrength(a, b, 0.5)).toBeNull();
    const made = await synapses.connect(a, b, 'causal', 'ctx', { strength: 0.33 });
    expect(made.synapse.strength).toBe(0.33);
    expect(made.synapse.co_access_count).toBe(1);

    const set = await synapses.setStrength(a, b, 1.7);
    expect(set!.strength).toBe(1);
    expect(set!.co_access_count).toBe(1);
    expect(set!.type).toBe('causal');
    expect(set!.context).toBe('ctx');
    expect((await synapses.setStrength(b, a, 0.12345))!.strength).toBe(0.123);
    expect((await synapses.connect(a, b, 'causal', undefined, { strength: -3 })).synapse.strength).toBe(0);
  });

  it('removeAllFor disconnects every synapse touching the neuron and keeps the manifest honest', async () => {
    const [a, b, c, d] = await four();
    const { synapses } = build();
    await synapses.connect(a, b, 'conceptual');
    await synapses.connect(a, c, 'conceptual');
    await synapses.connect(c, d, 'conceptual');
    expect((await brain.getManifest()).total_synapses).toBe(3);

    expect(await synapses.removeAllFor(a)).toBe(2);
    expect(await synapses.removeAllFor(a)).toBe(0);
    expect((await brain.getManifest()).total_synapses).toBe(1);
    expect((await readNeuron(b)).connections).toEqual([]);
    expect((await readNeuron(c)).connections).toEqual([d]);
    expect(await synapses.get(a, b)).toBeNull();
    expect(await synapses.get(c, d)).not.toBeNull();
  });

  it('rewire moves, merges (max strength, summed co-access) and drops the self loop', async () => {
    const [from, into, x, y] = await four();
    const { synapses } = build();
    await synapses.connect(from, x, 'dependency', 'from-x', { strength: 0.8 });     // moved
    await synapses.connect(from, y, 'causal', 'from-y', { strength: 0.9 });         // merged into into-y
    await synapses.connect(into, y, 'conceptual', 'into-y', { strength: 0.4 });
    await synapses.connect(into, y, 'conceptual');                                   // co_access 2
    await synapses.connect(from, into, 'temporal');                                  // dropped
    expect((await brain.getManifest()).total_synapses).toBe(4);

    const r = await synapses.rewire(from, into);
    expect(r).toEqual({ moved: 1, merged: 1, dropped: 1 });
    expect((await brain.getManifest()).total_synapses).toBe(2);

    const movedSyn = await synapses.get(into, x);
    expect(movedSyn).not.toBeNull();
    expect(movedSyn!.id).toBe(synapseId(into, x));
    expect([...movedSyn!.nodes].sort()).toEqual([into, x].sort());
    expect(movedSyn!.type).toBe('dependency');
    expect(movedSyn!.context).toBe('from-x');
    expect(await synapses.get(from, x)).toBeNull();

    const mergedSyn = (await synapses.get(into, y))!;
    expect(mergedSyn.strength).toBe(0.9);                       // max(0.9, 0.4 + 0.1 on strengthen)
    expect(mergedSyn.co_access_count).toBe(3);                  // 2 + 1
    expect(mergedSyn.context).toBe('into-y');                   // existing context kept
    expect(await synapses.get(from, y)).toBeNull();
    expect(await synapses.get(from, into)).toBeNull();

    expect([...(await readNeuron(into)).connections].sort()).toEqual([x, y].sort());
    expect((await readNeuron(x)).connections).toEqual([into]);
    expect((await readNeuron(y)).connections).toEqual([into]);
    // `from` itself is not cleaned: in the real flow Cortex.mergeNeurons has
    // already deleted its file before the server calls rewire.
    expect(await synapses.rewire(from, from)).toEqual({ moved: 0, merged: 0, dropped: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('Prefrontal: reads that do not write, setLastSession, live global map', () => {
  it('updateContext({}) and empty strings return written:false without touching the file', async () => {
    const { prefrontal } = build();
    await prefrontal.updateContext({ add_pending: 'Algo pendiente de verdad' });
    const file = brain.paths.activeContext();
    const before = await fs.stat(file);
    await new Promise(r => setTimeout(r, 20));

    const r1 = await prefrontal.updateContext({});
    const r2 = await prefrontal.updateContext({ add_pending: '', resolve_pending: '', discard_pending: '', clear: false });
    expect(r1.written).toBe(false);
    expect(r2.written).toBe(false);
    expect(r1.pending_tasks).toHaveLength(1);
    expect(r1.resolved).toEqual([]);
    expect(r1.discarded).toEqual([]);
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  it('setLastSession only moves last_session and last_updated', async () => {
    const { prefrontal } = build();
    await prefrontal.updateContext({ set_topics: ['project_a'], add_pending: 'Tarea que sigue abierta' });
    const before = await prefrontal.getContext();
    await new Promise(r => setTimeout(r, 5));
    await prefrontal.setLastSession('session_2026-09-03');
    const after = await prefrontal.getContext();
    expect(after.last_session).toBe('session_2026-09-03');
    expect(after.active_topics).toEqual(['project_a']);
    expect(after.pending_tasks).toEqual(before.pending_tasks);
    expect(after.last_updated >= before.last_updated).toBe(true);
  });

  it('getGlobalMap never writes global_map.json and reflects the cortex immediately', async () => {
    const { prefrontal, synapses } = build();
    const a = (await cortex.learn('Mapa A', 'fact', 'A.', { domain: 'd1' })).neuron!.id;
    const b = (await cortex.learn('Mapa B', 'fact', 'B.', { domain: 'd2' })).neuron!.id;
    const m1 = await prefrontal.getGlobalMap();
    expect(m1.clusters.map(c => c.name).sort()).toEqual(['d1', 'd2']);
    expect(m1.bridges).toEqual([]);
    await synapses.connect(a, b, 'conceptual');
    const m2 = await prefrontal.getGlobalMap();
    expect(m2.bridges).toHaveLength(1);
    expect(m2.bridges[0].via).toContain(b);
    expect(m2.last_rebuilt >= m1.last_rebuilt).toBe(true);
    await expect(fs.access(brain.paths.globalMap())).rejects.toThrow();
    expect(typeof (prefrontal as any).buildGlobalMap).toBe('undefined');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('Hippocampus: redacted logs, audit, forgetSession; Maintenance.consolidate', () => {
  const token = 'ghp_' + 'B'.repeat(36);

  it('logSession strips a credential from the summary and names its kind', async () => {
    const { hippocampus } = build();
    const log = await hippocampus.logSession({ summary: `Rotamos el token ${token} en CI.`, topics_touched: ['project_ci'] });
    expect(log.redacted).toEqual(['GitHub token']);
    expect(log.summary).not.toContain(token);
    expect(log.summary).toContain('Rotamos el token');
    const stored = JSON.parse(await fs.readFile(brain.paths.session(log.session_id), 'utf-8'));
    expect(stored.summary).not.toContain(token);
    expect(await hippocampus.auditSecrets()).toEqual([]);
  });

  it('auditSecrets finds a pre-2.0 log written raw, and forgetSession quarantines it', async () => {
    const { hippocampus } = build();
    const raw = {
      session_id: 'session_2020-01-01', date: '2020-01-01', duration_estimate: 'unknown',
      topics_touched: [], summary: `Antiguo: ${token}`, key_facts_added: 0, decisions_made: 0,
      new_neurons_created: 0, synapses_updated: 0,
    };
    await fs.writeFile(brain.paths.session('session_2020-01-01'), JSON.stringify(raw), 'utf-8');
    await brain.updateManifest({ total_sessions: 1 });

    const found = await hippocampus.auditSecrets();
    expect(found).toEqual([{ session_id: 'session_2020-01-01', date: '2020-01-01', kinds: ['GitHub token'] }]);
    expect(JSON.stringify(found)).not.toContain(token);

    const r = await hippocampus.forgetSession('2020-01-01');
    expect(r.session_id).toBe('session_2020-01-01');
    expect(r.removed).toBe(true);
    expect(r.backup!.startsWith(brain.paths.quarantine)).toBe(true);
    await expect(fs.access(r.backup!)).resolves.toBeUndefined();
    await expect(fs.access(brain.paths.session('session_2020-01-01'))).rejects.toThrow();
    expect((await brain.getManifest()).total_sessions).toBe(0);
    expect(await hippocampus.listSessions()).toEqual([]);

    expect(await hippocampus.forgetSession('session_2020-01-01')).toEqual({ session_id: 'session_2020-01-01', removed: false, backup: null });
    expect((await brain.getManifest()).total_sessions).toBe(0);      // floor, not negative
  });

  it('consolidate returns session_id and redacted, and points the context at that session', async () => {
    const { maintenance, prefrontal, hippocampus } = build();
    await cortex.learn('Consolidar', 'fact', 'Un hecho de la sesion.');
    const r = await maintenance.consolidate(`Cerramos con ${token} a la vista.`);
    expect(r.session_logged).toBe(true);
    expect(r.session_id).toMatch(/^session_\d{4}-\d{2}-\d{2}$/);
    expect(r.redacted).toEqual(['GitHub token']);
    expect(r.facts_saved).toBe(1);
    expect((await prefrontal.getContext()).last_session).toBe(r.session_id);
    expect((await hippocampus.listSessions(1))[0].summary).not.toContain(token);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('SearchEngine: retired entries leave recall, removeNeuron drops a neuron', () => {
  it('a retired pattern disappears from search and comes back on reactivation', async () => {
    const { search } = build();
    cortex.setIndexer(n => search.indexNeuron(n));
    cortex.setRemover(id => search.removeNeuron(id));
    await search.init();

    const pattern = 'Encriptar los volcados nocturnos con age antes de subirlos.';
    const { neuron } = await cortex.learn('Indice Retirados', 'pattern', pattern);
    const find = async () => (await search.search('encriptar volcados nocturnos age'))
      .filter(r => r.neuron_id === neuron!.id && r.matching_content.includes('Encriptar'));

    expect((await find()).length).toBeGreaterThan(0);
    await cortex.retireEntries(neuron!.id, [pattern]);
    expect(await find()).toEqual([]);
    await cortex.retireEntries(neuron!.id, [pattern], { status: 'active' });
    expect((await find()).length).toBeGreaterThan(0);
  });

  it('removeNeuron takes every chunk of the neuron out and is a no-op afterwards', async () => {
    const { search } = build();
    cortex.setIndexer(n => search.indexNeuron(n));
    await search.init();
    const { neuron } = await cortex.learn('Neurona Quitada', 'fact', 'Un hecho muy concreto sobre pangolines voladores.');
    expect((await search.search('pangolines voladores'))[0]?.neuron_id).toBe(neuron!.id);

    await search.removeNeuron(neuron!.id);
    expect((await search.search('pangolines voladores')).filter(r => r.neuron_id === neuron!.id)).toEqual([]);
    await expect(search.removeNeuron(neuron!.id)).resolves.toBeUndefined();
    await expect(search.removeNeuron('never_indexed')).resolves.toBeUndefined();
  });

  it('forgetNeuron through the cortex reaches the index via the remover hook', async () => {
    const { search } = build();
    cortex.setIndexer(n => search.indexNeuron(n));
    cortex.setRemover(id => search.removeNeuron(id));
    await search.init();
    const { neuron } = await cortex.learn('Olvidada Del Todo', 'fact', 'Una frase sobre ornitorrincos contables.');
    expect((await search.search('ornitorrincos contables')).length).toBeGreaterThan(0);

    const r = await cortex.forgetNeuron('Olvidada Del Todo');
    expect(r.neuron_id).toBe(neuron!.id);
    expect(r.counts.facts).toBe(1);
    expect((await search.search('ornitorrincos contables')).filter(x => x.neuron_id === neuron!.id)).toEqual([]);
    expect(await cortex.peek(neuron!.id)).toBeNull();
    expect((await brain.getManifest()).total_neurons).toBe(0);
    expect(await cortex.forgetNeuron('nadie')).toEqual({
      neuron_id: null, backup: null,
      counts: { facts: 0, decisions: 0, patterns: 0, preferences: 0, errors: 0, debts: 0, connections: 0 },
    });
  });

  it('the index format is version 5, so a pre-2.0 index is rebuilt', () => {
    expect(INDEX_VERSION).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('Maintenance: archive round trip, retired debts, dry run on the whole root', () => {
  const makeCold = async (id: string) => {
    const old = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString();
    await fs.writeFile(brain.paths.neuron(id), JSON.stringify({
      id, name: id, domain: 'general', type: 'project',
      created: old, last_accessed: old, access_count: 0, heat: 0,
      summary: '', facts: [{ text: 'algo que importaba', confidence: 1, added: old, source: 'session' }],
      decisions: [], patterns: [], preferences: [], connections: [], tags: [],
    }), 'utf-8');
  };

  it('archive moves a cold neuron out, unarchive brings it back and reindexes it', async () => {
    await makeCold('project_frio');
    await cortex.learn('Caliente', 'fact', 'Neurona reciente que no se archiva.');
    const { maintenance, search } = build();

    const archived = await maintenance.run(false, { archive: true });
    expect(archived.archived_neurons).toBe(1);
    expect(archived.archives_count).toBe(1);
    expect(await cortex.peek('project_frio')).toBeNull();
    await expect(fs.access(path.join(brain.paths.archives, 'project_frio.json'))).resolves.toBeUndefined();

    const dry = await maintenance.run(true, { unarchive: 'all' });
    expect(dry.unarchived_neurons).toBe(0);
    expect(dry.archives_count).toBe(1);
    expect(dry.notes.join(' ')).toContain('nothing was unarchived');

    const back = await maintenance.run(false, { unarchive: ['project_frio', 'project_desconocido'] });
    expect(back.unarchived_neurons).toBe(1);
    expect(back.archives_count).toBe(0);
    expect(back.notes.join(' ')).toContain('project_desconocido');
    expect(await cortex.peek('project_frio')).not.toBeNull();
    expect((await search.search('algo que importaba')).map(r => r.neuron_id)).toContain('project_frio');
    // Unarchived in this pass, so the same pass did not re-archive it, and it is still there.
    const again = await maintenance.run(false, { unarchive: 'all', archive: true });
    expect(again.unarchived_neurons).toBe(0);
  }, 30_000);

  it('retired debts do not count towards debts_total or debts_without_trigger', async () => {
    // The trigger check is a regex on REVISAR CUANDO / REVISIT WHEN / TRIGGER: / DISPARADOR,
    // so the "without" text must avoid all four words.
    const sin = 'DEFERRED: sin condicion de vuelta. CEILING: nada.';
    const con = 'DEFERRED: con condicion de vuelta. CEILING: nada. REVISIT WHEN: manana.';
    const { neuron } = await cortex.learn('Ledger', 'debt', sin);
    await cortex.learn('Ledger', 'debt', con);
    const { maintenance } = build();

    const before = await maintenance.run(true);
    expect(before.debts_total).toBe(2);
    expect(before.debts_without_trigger).toBe(1);

    await cortex.retireEntries(neuron!.id, [sin]);
    const after = await maintenance.run(true);
    expect(after.debts_total).toBe(1);
    expect(after.debts_without_trigger).toBe(0);
    expect(after.notes.join(' ')).not.toContain('never named a revisit condition');
  });

  it('a dry run with every option on changes no file anywhere under the root', async () => {
    for (let i = 0; i < 3; i++) await cortex.learn(`Tema ${i}`, 'fact', `Hecho ${i}.`);
    await makeCold('project_frio_dry');
    const { maintenance } = build();
    await maintenance.run(false);

    const snap = async (dir: string, base = dir): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) Object.assign(out, await snap(full, base));
        else { const st = await fs.stat(full); out[path.relative(base, full)] = `${st.mtimeMs}:${st.size}`; }
      }
      return out;
    };
    await new Promise(r => setTimeout(r, 20));
    const before = await snap(root);
    const report = await maintenance.run(true, { archive: true, repair: true, unarchive: 'all', purgeBoilerplate: true });
    expect(await snap(root)).toEqual(before);
    expect(report.archivable_neurons).toBe(1);
    expect(report.archived_neurons).toBe(0);
    expect(report.repaired).toBe(0);
    expect(report.index_rebuilt).toBe(false);
    await expect(fs.access(brain.paths.globalMap())).rejects.toThrow();
  }, 30_000);

  it('a leftover global_map.json cache is deleted by a real run and reported', async () => {
    await cortex.learn('Cache', 'fact', 'Hay una cache vieja.');
    await fs.writeFile(brain.paths.globalMap(), JSON.stringify({ last_rebuilt: 'x', clusters: [], bridges: [] }), 'utf-8');
    const { maintenance } = build();
    const dry = await maintenance.run(true);
    await expect(fs.access(brain.paths.globalMap())).resolves.toBeUndefined();
    expect(dry.notes.join(' ')).not.toContain('obsolete global_map.json');
    const real = await maintenance.run(false);
    await expect(fs.access(brain.paths.globalMap())).rejects.toThrow();
    expect(real.notes.join(' ')).toContain('obsolete global_map.json');
  }, 30_000);
});
