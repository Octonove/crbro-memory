// ─── Six defects found by auditing 1.5.1 against a real brain ────
//
// Each of these was invisible from inside: the code did something reasonable
// and reported success while quietly doing the wrong thing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { Synapses } from '../src/engine/synapses.js';
import { HeatEngine } from '../src/engine/heat.js';
import { Hippocampus } from '../src/engine/hippocampus.js';
import { Prefrontal } from '../src/engine/prefrontal.js';
import { SearchEngine } from '../src/search/index.js';
import { Maintenance } from '../src/engine/maintenance.js';
import { toSnakeCase, legacySnakeCase, neuronId } from '../src/utils/ids.js';

let root: string;
let brain: Brain;
let cortex: Cortex;

const build = () => {
  const synapses = new Synapses(brain);
  const heat = new HeatEngine(brain);
  const hippocampus = new Hippocampus(brain);
  const prefrontal = new Prefrontal(brain);
  const search = new SearchEngine(brain);
  return {
    heat,
    search,
    maintenance: new Maintenance(brain, cortex, synapses, heat, hippocampus, prefrontal, search),
  };
};

/** mtimes of every neuron file, to prove what a call did or did not touch. */
const mtimes = async () => {
  const out: Record<string, number> = {};
  for (const f of await fs.readdir(brain.paths.cortex)) {
    if (!f.endsWith('.json')) continue;
    out[f] = (await fs.stat(path.join(brain.paths.cortex, f))).mtimeMs;
  }
  return out;
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-int-'));
  brain = new Brain(root);
  await brain.initialize();
  cortex = new Cortex(brain);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('the index notices when the cortex moves on', () => {
  it('rebuilds when a neuron is newer than the index', async () => {
    await cortex.learn('Acme Platform', 'fact', 'The deploy runs on Cloud Run.');
    const engine = new SearchEngine(brain);
    await engine.rebuild();
    expect((await engine.search('Cloud Run'))[0]?.neuron_id).toBe('project_acme_platform');

    // A second client writes a neuron straight to disk without telling us —
    // exactly what a separate process does.
    const smuggled = {
      id: 'project_smuggled', name: 'Smuggled', domain: 'general', type: 'project',
      created: new Date().toISOString(), last_accessed: new Date().toISOString(),
      access_count: 1, heat: 0.5, summary: '',
      facts: [{ text: 'A pangolin ate the deployment key.', confidence: 1, added: new Date().toISOString(), source: 'session' }],
      decisions: [], patterns: [], preferences: [], connections: [], tags: [],
    };
    await new Promise(r => setTimeout(r, 1100)); // clear the one-second slack
    await fs.writeFile(brain.paths.neuron('project_smuggled'), JSON.stringify(smuggled), 'utf-8');

    // A fresh engine must not trust the index it finds on disk.
    const fresh = new SearchEngine(brain);
    await fresh.init();
    const results = await fresh.search('pangolin');
    expect(results[0]?.neuron_id).toBe('project_smuggled');
  }, 30_000);
});

describe('a dry run writes nothing', () => {
  it('leaves every neuron file untouched', async () => {
    for (let i = 0; i < 5; i++) {
      await cortex.learn(`Topic ${i}`, 'fact', `Something worth keeping number ${i}.`);
    }
    const { maintenance } = build();
    await maintenance.run(false); // settle heat first

    const antes = await mtimes();
    await new Promise(r => setTimeout(r, 20));
    const report = await maintenance.run(true);
    const despues = await mtimes();

    const tocados = Object.keys(antes).filter(f => antes[f] !== despues[f]);
    expect(tocados).toEqual([]);
    expect(report.heat_recalculated).toBe(false);
  }, 30_000);
});

describe('heat only writes when the number moved', () => {
  it('does not rewrite neurons on a second consecutive pass', async () => {
    for (let i = 0; i < 5; i++) {
      await cortex.learn(`Topic ${i}`, 'fact', `Fact number ${i}.`);
    }
    const { heat } = build();
    await heat.recalculate();

    const antes = await mtimes();
    await new Promise(r => setTimeout(r, 20));
    await heat.recalculate();
    const despues = await mtimes();

    const tocados = Object.keys(antes).filter(f => antes[f] !== despues[f]);
    expect(tocados).toEqual([]);
  }, 30_000);
});

describe('consolidate reports what really happened', () => {
  it('counts the session, not the whole brain', async () => {
    // Twelve neurons exist, but this session only wrote three facts.
    for (let i = 0; i < 12; i++) {
      await cortex.learn(`Old topic ${i}`, 'fact', `Something from before, ${i}.`);
    }
    cortex.resetSessionTally();

    await cortex.learn('Acme Platform', 'fact', 'One.');
    await cortex.learn('Acme Platform', 'fact', 'Two.');
    await cortex.learn('Widget Catalog', 'fact', 'Three.');
    await cortex.learn('Widget Catalog', 'decision', 'Ship it.', { rationale: 'because' });

    const { maintenance } = build();
    const r = await maintenance.consolidate('a short session');

    expect(r.facts_saved).toBe(3);          // used to answer 14, the neuron count
    expect(r.decisions_saved).toBe(1);
    expect(r.topics_touched).toBe(2);
    expect(r.total_neurons).toBeGreaterThan(3);

    // And the tally resets, so the next session starts from zero.
    expect(cortex.sessionTally().facts).toBe(0);
  }, 30_000);
});

describe('accented names produce usable ids', () => {
  it('folds the accent instead of deleting the letter', () => {
    expect(toSnakeCase('búsqueda de propiedades')).toBe('busqueda_de_propiedades');
    expect(toSnakeCase('SEO técnico')).toBe('seo_tecnico');
    expect(toSnakeCase('Análisis de la web')).toBe('analisis_de_la_web');
    expect(neuronId('Búsqueda', 'project')).toBe('project_busqueda');

    // The old behaviour, kept only so existing files stay reachable.
    expect(legacySnakeCase('búsqueda de propiedades')).toBe('bsqueda_de_propiedades');
  });

  it('does not merge topics that differ only by a number', async () => {
    // Bigram similarity puts "sprint_2" and "sprint_3" at 0.857, above the
    // threshold. Merging them would file one sprint's knowledge under another.
    await cortex.learn('Sprint 2', 'fact', 'Sprint 2 shipped the importer.');
    const r = await cortex.learn('Sprint 3', 'fact', 'Sprint 3 shipped the exporter.');

    expect(r.action).toBe('created');
    expect(r.neuron!.id).toBe('project_sprint_3');

    const dos = await cortex.peek('project_sprint_2');
    expect(dos!.facts.length).toBe(1);
    expect(dos!.facts[0].text).toContain('importer');
  }, 30_000);

  it('still finds a neuron stored under the old mangled name', async () => {
    const viejo = {
      id: 'lang_bsqueda_de_propiedades', name: 'búsqueda de propiedades',
      domain: 'general', type: 'lang',
      created: '2026-01-01T00:00:00.000Z', last_accessed: '2026-01-01T00:00:00.000Z',
      access_count: 3, heat: 0.4, summary: '',
      facts: [{ text: 'Un hecho antiguo.', confidence: 1, added: '2026-01-01T00:00:00.000Z', source: 'session' }],
      decisions: [], patterns: [], preferences: [], connections: [], tags: [],
    };
    await fs.writeFile(brain.paths.neuron(viejo.id), JSON.stringify(viejo), 'utf-8');

    const found = await cortex.findByName('búsqueda de propiedades');
    expect(found?.id).toBe('lang_bsqueda_de_propiedades');

    // And learning into it must not fork a second neuron.
    const r = await cortex.learn('búsqueda de propiedades', 'fact', 'Un hecho nuevo.');
    expect(r.action).toBe('updated');
    expect(r.neuron!.id).toBe('lang_bsqueda_de_propiedades');
  }, 30_000);
});
