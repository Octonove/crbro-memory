// ─── 2.11: supersedes, quarantine, archive, decay, heat, diary ───
//
// The housekeeping findings of the engine audit, one block each: what used to
// happen, and what has to happen now.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex, type Emitter } from '../src/engine/cortex.js';
import { Synapses, decayedStrength } from '../src/engine/synapses.js';
import { HeatEngine, readHeatState } from '../src/engine/heat.js';
import { Hippocampus } from '../src/engine/hippocampus.js';
import { Prefrontal } from '../src/engine/prefrontal.js';
import { SearchEngine } from '../src/search/index.js';
import { Maintenance } from '../src/engine/maintenance.js';
import { listQuarantine, pruneQuarantine, quarantineDays, readQuarantine } from '../src/engine/quarantine.js';
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
  return { synapses, heat, hippocampus, search, maintenance: new Maintenance(brain, cortex, synapses, heat, hippocampus, prefrontal, search) };
};

const old = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

async function writeNeuron(n: Partial<Neuron> & { id: string }) {
  const full: Neuron = {
    name: n.id, domain: 'general', type: 'project', created: old(200), last_accessed: old(200), access_count: 0, heat: 0,
    summary: '', facts: [], decisions: [], patterns: [], preferences: [], connections: [], tags: [], errors: [], debts: [], entry_dates: {},
    ...n,
  } as Neuron;
  await fs.writeFile(brain.paths.neuron(n.id), JSON.stringify(full, null, 2));
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-c1-life-'));
  brain = new Brain(root);
  await brain.initialize();
  cortex = new Cortex(brain);
});

afterEach(async () => {
  delete process.env.CRBRO_QUARANTINE_DAYS;
  await fs.rm(root, { recursive: true, force: true });
});

describe('supersedes (M8, M9)', () => {
  it('applies when the new fact already exists — the retry after fixing a mistyped id', async () => {
    const viejo = await cortex.learn('Precios', 'fact', 'El plan basico cuesta 9 euros al mes.');
    const viejoId = viejo.neuron!.facts[0].id!;
    const primero = await cortex.learn('Precios', 'fact', 'El plan basico cuesta 12 euros al mes.', { supersedes: ['idmalescrito'] });
    expect(primero.supersedes_unmatched).toEqual(['idmalescrito']);
    const reintento = await cortex.learn('Precios', 'fact', 'El plan basico cuesta 12 euros al mes.', { supersedes: [viejoId] });
    expect(reintento.duplicate).toBe(true);
    expect(reintento.superseded).toBe(1);
    const n = await cortex.peek('project_precios');
    expect(n!.facts.find(f => f.id === viejoId)!.status).toBe('superseded');
    // And again: the target is already retired, which is not a miss.
    const otraVez = await cortex.learn('Precios', 'fact', 'El plan basico cuesta 12 euros al mes.', { supersedes: [viejoId] });
    expect(otraVez.superseded).toBe(0);
    expect(otraVez.supersedes_unmatched).toEqual([]);
  });

  it('the retirement travels to shared spaces through the emitter, like crbro_revise', async () => {
    const enviados: Array<Parameters<Emitter>[1]> = [];
    cortex.setEmitter((_id, change) => { enviados.push(change); });
    const v = await cortex.learn('Version', 'fact', 'La API va por la version 3.');
    const fid = v.neuron!.facts[0].id!;
    await cortex.learn('Version', 'fact', 'La API va por la version 4.', { supersedes: [fid] });
    expect(enviados.some(c => c.kind === 'status' && c.fid === fid && c.to === 'superseded')).toBe(true);
  });

  it('a fact never supersedes itself', async () => {
    const r = await cortex.learn('Solo', 'fact', 'Una linea.');
    const id = r.neuron!.facts[0].id!;
    const again = await cortex.learn('Solo', 'fact', 'Una linea.', { supersedes: [id, 'Una linea.'] });
    expect(again.superseded).toBe(0);
    expect((await cortex.peek('project_solo'))!.facts[0].status).toBe('active');
  });
});

describe('one identity rule (M13)', () => {
  it('a pattern differing by a line break is the same pattern; a decision retried is one decision', async () => {
    await cortex.learn('Reglas', 'pattern', 'Primero la copia\nluego el cambio.');
    await cortex.learn('Reglas', 'pattern', 'Primero la copia luego el cambio.');
    await cortex.learn('Reglas', 'decision', 'Usar Postgres.', { rationale: 'transacciones' });
    await cortex.learn('Reglas', 'decision', 'Usar  Postgres.');
    await cortex.learn('Reglas', 'fact', 'Un hecho con salto final.');
    const d = await cortex.learn('Reglas', 'fact', 'Un hecho con salto final.\n');
    expect(d.duplicate).toBe(true);
    const n = await cortex.peek('project_reglas');
    expect(n!.patterns).toHaveLength(1);
    expect(n!.decisions).toHaveLength(1);
    expect(n!.facts).toHaveLength(1);
  });
});

describe('quarantine (M16, H12)', () => {
  it('forgetting some entries keeps those entries and what restore needs, not the neuron', async () => {
    for (let i = 0; i < 20; i++) await cortex.learn('Grande', 'fact', `Hecho de relleno numero ${i} que pesa.`);
    await cortex.learn('Grande', 'pattern', 'Patron que se olvida.');
    const r = await cortex.forget('project_grande', ['Hecho de relleno numero 3 que pesa.', 'Patron que se olvida.']);
    expect(r.removed).toBe(2);
    expect(r.backup!.endsWith('.entries.json')).toBe(true);
    const q = await readQuarantine<any>(r.backup!);
    expect(q.kind).toBe('entries');
    expect(q.facts).toHaveLength(1);
    expect(q.patterns).toEqual(['Patron que se olvida.']);
    expect(Object.keys(q.entry_dates || {})).toHaveLength(1);
    const restored = await cortex.restoreNeuron('project_grande');
    expect(restored.merged_into_existing).toBe(true);
    const n = await cortex.peek('project_grande');
    expect(n!.facts).toHaveLength(20);
    expect(n!.patterns).toContain('Patron que se olvida.');
    expect(Object.keys(n!.entry_dates || {})).toHaveLength(1);
  });

  it('a forget that removes nothing leaves no copy', async () => {
    await cortex.learn('Nada', 'fact', 'Algo.');
    const r = await cortex.forget('project_nada', ['no existe']);
    expect(r.removed).toBe(0);
    expect(await listQuarantine(brain.paths.quarantine)).toEqual([]);
  });

  it('forget entire and restore still round-trip (whole copy)', async () => {
    await cortex.learn('Entera', 'fact', 'Todo esto vuelve.');
    const f = await cortex.forgetNeuron('project_entera');
    expect(f.backup!.endsWith('.json')).toBe(true);
    expect(await cortex.peek('project_entera')).toBeNull();
    const r = await cortex.restoreNeuron('project_entera');
    expect(r.merged_into_existing).toBe(false);
    expect((await cortex.peek('project_entera'))!.facts[0].text).toBe('Todo esto vuelve.');
  });

  it('retention: CRBRO_QUARANTINE_DAYS (default 180, 0 = forever), pruned with a count by maintenance and consolidate', async () => {
    expect(quarantineDays({})).toBe(180);
    expect(quarantineDays({ CRBRO_QUARANTINE_DAYS: '0' })).toBe(0);
    expect(quarantineDays({ CRBRO_QUARANTINE_DAYS: 'x' })).toBe(180);
    await fs.mkdir(brain.paths.quarantine, { recursive: true });
    await fs.writeFile(path.join(brain.paths.quarantine, 'project_a.2025-01-01T00-00-00-000Z.json'), '{}');
    await fs.writeFile(path.join(brain.paths.quarantine, 'project_b.2025-02-01T00-00-00-000Z.entries.json'), '{}');
    await fs.writeFile(path.join(brain.paths.quarantine, `project_c.${new Date().toISOString().replace(/[:.]/g, '-')}.json`), '{}');
    expect((await pruneQuarantine(brain.paths.quarantine, { days: 0 })).pruned).toBe(0);
    const { maintenance } = build();
    await cortex.learn('Algo', 'fact', 'Para que haya cerebro.');
    const dry = await maintenance.run(true);
    expect(dry.quarantine_pruned).toBe(2);
    expect((await listQuarantine(brain.paths.quarantine))).toHaveLength(3);
    process.env.CRBRO_QUARANTINE_DAYS = '30';
    await fs.writeFile(path.join(brain.paths.quarantine, 'project_d.2025-03-01T00-00-00-000Z.json'), '{}');
    const c = await maintenance.consolidate('cierre');
    expect(c.quarantine_pruned).toBe(3);
    expect((await listQuarantine(brain.paths.quarantine)).map(x => x.id)).toEqual(['project_c']);
  }, 30_000);
});

describe('archive (H2, H3)', () => {
  it('never archives protocols or shared neurons; dry_run lists exactly the rest', async () => {
    await writeNeuron({ id: 'project_fria', facts: [{ text: 'x', confidence: 1, added: old(200), source: 'session', id: 'a', status: 'active' } as any] });
    await writeNeuron({ id: 'protocol_regla', type: 'protocol', facts: [{ text: 'Siempre verificar.', confidence: 1, added: old(200), source: 'session', id: 'b', status: 'active' } as any] });
    await writeNeuron({ id: 'project_compartida' });
    const { maintenance } = build();
    const dry = await maintenance.run(true, { sharedIds: new Set(['project_compartida']) });
    expect(dry.archivable_ids).toEqual(['project_fria']);
    expect(dry.archivable_neurons).toBe(1);
    const real = await maintenance.run(false, { archive: true, sharedIds: new Set(['project_compartida']) });
    expect(real.archived_neurons).toBe(1);
    expect(await cortex.peek('protocol_regla')).not.toBeNull();
    expect(await cortex.peek('project_compartida')).not.toBeNull();
  }, 30_000);

  it('archive + repair keep the synapses and connections; unarchive brings the neuron back connected', async () => {
    await writeNeuron({ id: 'project_fria' });
    await writeNeuron({ id: 'project_viva', last_accessed: new Date().toISOString(), access_count: 9 });
    const { synapses, maintenance } = build();
    await synapses.connect('project_fria', 'project_viva', 'dependency', 'depende', { strength: 0.9 });
    // Heat counts connections against the best-connected neuron: give that
    // one plenty, so one link alone does not make project_fria warm.
    for (let i = 0; i < 30; i++) {
      await writeNeuron({ id: `project_hoja_${i}`, last_accessed: new Date().toISOString() });
      await synapses.connect('project_viva', `project_hoja_${i}`, 'conceptual');
    }
    const r = await maintenance.run(false, { archive: true, repair: true });
    expect(r.archived_neurons).toBe(1);
    expect(r.integrity_issues.filter(i => /Broken connection|Orphan synapse/.test(i))).toEqual([]);
    expect(r.repairs.filter(x => /orphan synapse|dangling/i.test(x))).toEqual([]);
    expect(await synapses.count()).toBe(31);
    expect((await cortex.peek('project_viva'))!.connections).toContain('project_fria');
    const back = await maintenance.run(false, { unarchive: ['project_fria'] });
    expect(back.unarchived_neurons).toBe(1);
    const n = await cortex.peek('project_fria');
    expect(n!.connections).toEqual(['project_viva']);
    expect((await synapses.getConnections('project_fria')).map(c => c.target_id)).toEqual(['project_viva']);
  }, 30_000);
});

describe('synapse decay follows elapsed time (M15, H13)', () => {
  it('the same week of idleness decays the same, whatever the number of runs', () => {
    const una = decayedStrength(0.5, 40, 7);
    let siete = 0.5;
    for (let d = 0; d < 7; d++) siete = decayedStrength(siete, 40, 1);
    expect(Math.abs(una - siete)).toBeLessThan(0.005);
    expect(decayedStrength(0.5, 3, 30)).toBe(0.5);   // not idle: no decay
  });

  it('running maintenance twice in a row does not decay twice; a pruned link goes to quarantine first', async () => {
    await writeNeuron({ id: 'project_x1' });
    await writeNeuron({ id: 'project_x2' });
    const { synapses } = build();
    await synapses.connect('project_x1', 'project_x2', 'temporal', '', { initialStrength: 0.3 });
    const f = brain.paths.synapse('syn_x1__x2');
    const s = JSON.parse(await fs.readFile(f, 'utf8'));
    s.last_co_access = old(100); s.decayed_at = old(14);
    await fs.writeFile(f, JSON.stringify(s));
    await synapses.decay();
    const una = JSON.parse(await fs.readFile(f, 'utf8')).strength;
    expect(una).toBeCloseTo(0.3 * 0.8 * 0.8, 2);
    await synapses.decay();
    expect(JSON.parse(await fs.readFile(f, 'utf8')).strength).toBe(una);
    const t = JSON.parse(await fs.readFile(f, 'utf8'));
    t.decayed_at = old(400);
    await fs.writeFile(f, JSON.stringify(t));
    expect(await synapses.decay(0.05, { dryRun: true })).toBe(1);
    expect(await synapses.count()).toBe(1);
    expect(await synapses.decay()).toBe(1);
    expect(await synapses.count()).toBe(0);
    expect((await listQuarantine(brain.paths.quarantine)).map(q => q.id)).toEqual(['syn_x1__x2']);
  });
});

describe('heat lives in a derived state file (M3)', () => {
  it('consolidate-time heat reads only changed neurons and never rewrites a neuron', async () => {
    for (let i = 0; i < 6; i++) await cortex.learn(`Tema numero ${i}x`, 'fact', `Hecho ${i}.`);
    const { heat } = build();
    const mt = async () => Object.fromEntries(await Promise.all((await fs.readdir(brain.paths.cortex)).map(async f => [f, (await fs.stat(path.join(brain.paths.cortex, f))).mtimeMs])));
    const antes = await mt();
    await heat.recalculate();
    expect(heat.lastRead).toBe(6);
    expect(await mt()).toEqual(antes);
    const estado = await readHeatState(brain);
    expect(Object.keys(estado!.neurons)).toHaveLength(6);
    await heat.recalculate();
    expect(heat.lastRead).toBe(0);
    await cortex.learn('Tema numero 2x', 'fact', 'Otro.');
    await heat.recalculate();
    expect(heat.lastRead).toBe(1);
    // Readers in the engine use it.
    const lista = await cortex.list();
    const ahora = await readHeatState(brain);
    expect(lista.find(n => n.id === 'project_tema_numero_2x')!.heat).toBe(ahora!.neurons['project_tema_numero_2x'].heat);
  });
});

describe('the diary (M14)', () => {
  it('listSessions reads only the newest files it returns', async () => {
    for (const d of ['2026-01-01', '2026-03-01', '2026-02-01']) {
      await fs.writeFile(brain.paths.session(`session_${d}`), JSON.stringify({ session_id: `session_${d}`, date: d, summary: d, topics_touched: [] }));
    }
    // A corrupt old log must not break the listing.
    await fs.writeFile(brain.paths.session('session_2025-01-01'), '{"roto');
    const h = new Hippocampus(brain);
    expect((await h.listSessions(2)).map(s => s.date)).toEqual(['2026-03-01', '2026-02-01']);
    expect((await h.listSessions(10)).map(s => s.date)).toEqual(['2026-03-01', '2026-02-01', '2026-01-01']);
  });
});
