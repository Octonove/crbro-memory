// ─── Write routing, archiving and pending items ──────────────────
//
// Three failures that no amount of search tuning would have fixed, because
// they corrupt the data rather than the ranking.

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
import { fileExists } from '../src/utils/fs.js';

let root: string;
let brain: Brain;
let cortex: Cortex;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-rt-'));
  brain = new Brain(root);
  await brain.initialize();
  cortex = new Cortex(brain);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('findByName does not guess', () => {
  beforeEach(async () => {
    // The kind of neuron the miner used to manufacture out of a heading.
    await cortex.learn(
      'walkthrough skill articulo coches chinos primera publicacion',
      'fact',
      'Paso 3 del walkthrough.',
    );
    await cortex.learn('Coches Chinos', 'fact', 'Blog SEO sobre coches chinos en Espana.');
    await cortex.learn(
      'walkthrough creacion de 4 2 pendientes workflows de backlinks seo',
      'fact',
      'Pendiente 4.2 del walkthrough.',
    );
  });

  it('routes an exact name to its own neuron', async () => {
    const n = await cortex.findByName('Coches Chinos');
    expect(n?.id).toBe('project_coches_chinos');
  });

  it('does not swallow a short name into a long unrelated id', async () => {
    // Substring containment used to send this into the walkthrough neuron.
    // Returning null is the correct answer: the caller then creates a real
    // 'SEO' neuron instead of burying the knowledge somewhere unrelated.
    const n = await cortex.findByName('SEO');
    expect(n === null || !n.id.includes('walkthrough')).toBe(true);
  });

  it('creates a new neuron rather than writing into a near-miss', async () => {
    const result = await cortex.learn('SEO', 'fact', 'El SEO es una cadena de montaje.');
    expect(result.action).toBe('created');
    expect(result.neuron!.id).not.toContain('walkthrough');
  });

  it('never overwrites an existing neuron when creating', async () => {
    const before = await cortex.peek('project_coches_chinos');
    const again = await cortex.create('Coches Chinos', 'project', 'otro-dominio');
    expect(again.facts.length).toBe(before!.facts.length);
    expect(again.facts[0].text).toBe(before!.facts[0].text);
  });
});

describe('maintenance does not archive behind your back', () => {
  const buildMaintenance = () => {
    const synapses = new Synapses(brain);
    const heat = new HeatEngine(brain);
    const hippocampus = new Hippocampus(brain);
    const prefrontal = new Prefrontal(brain);
    const search = new SearchEngine(brain);
    return new Maintenance(brain, cortex, synapses, heat, hippocampus, prefrontal, search);
  };

  const makeColdNeuron = async (id: string) => {
    const old = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString();
    await fs.writeFile(
      brain.paths.neuron(id),
      JSON.stringify({
        id, name: id, domain: 'general', type: 'project',
        created: old, last_accessed: old, access_count: 0, heat: 0,
        summary: '', facts: [{ text: 'algo que importaba', confidence: 1, added: old, source: 'session' }],
        decisions: [], patterns: [], preferences: [], connections: [], tags: [],
      }),
      'utf-8',
    );
  };

  it('reports cold neurons but leaves them in place', async () => {
    await makeColdNeuron('project_frio_uno');
    await makeColdNeuron('project_frio_dos');
    await makeColdNeuron('project_frio_tres');

    const report = await buildMaintenance().run(false);

    expect(report.archived_neurons).toBe(0);
    expect(report.archivable_neurons).toBe(3);
    expect(await fileExists(brain.paths.neuron('project_frio_uno'))).toBe(true);
    expect(await fileExists(brain.paths.neuron('project_frio_tres'))).toBe(true);
    expect(report.notes.join(' ')).toContain('Nothing was archived');
  });

  it('archives only when explicitly asked', async () => {
    await makeColdNeuron('project_frio_uno');
    const report = await buildMaintenance().run(false, { archive: true });

    expect(report.archived_neurons).toBe(1);
    expect(await fileExists(brain.paths.neuron('project_frio_uno'))).toBe(false);
    expect(await fileExists(path.join(brain.paths.archives, 'project_frio_uno.json'))).toBe(true);
  });
});

describe('pending items can actually be closed', () => {
  it('resolves by id and by a fragment of the text', async () => {
    const prefrontal = new Prefrontal(brain);

    const long =
      'Publicar los 4 satelites del cluster de workflows con sus fichas, ' +
      'segun lo acordado: SEO el 4-09, contenido el 7-09, programacion el 10-09 ' +
      'y administracion el 13-09, cada uno enlazando al pilar.';

    await prefrontal.updateContext({ add_pending: long });
    await prefrontal.updateContext({ add_pending: 'Rotar las credenciales expuestas' });

    let ctx = await prefrontal.getContext();
    expect(ctx.pending_tasks.length).toBe(2);

    // A fragment is enough. Exact-string matching made real items unresolvable.
    const afterFragment = await prefrontal.updateContext({
      resolve_pending: 'Publicar los 4 satelites del cluster',
    });
    expect(afterFragment.resolved?.length).toBe(1);

    ctx = await prefrontal.getContext();
    expect(ctx.pending_tasks.length).toBe(1);
    expect(ctx.recently_closed?.length).toBe(1);

    // And by id.
    const id = (ctx.pending_tasks[0] as any).id as string;
    expect(id).toMatch(/^p_/);
    await prefrontal.updateContext({ resolve_pending: id });

    ctx = await prefrontal.getContext();
    expect(ctx.pending_tasks.length).toBe(0);
    expect(ctx.recently_closed?.length).toBe(2);
  });

  it('surfaces open and recently closed items at boot', async () => {
    const prefrontal = new Prefrontal(brain);
    await prefrontal.updateContext({ add_pending: 'Terminar el informe trimestral' });
    await prefrontal.updateContext({ add_pending: 'Revisar las imagenes del reto' });
    await prefrontal.updateContext({ resolve_pending: 'Revisar las imagenes' });

    const boot = await brain.boot();
    expect(boot.open_items?.length).toBe(1);
    expect(boot.open_items?.[0].text).toContain('informe trimestral');
    expect(boot.recently_closed?.length).toBe(1);
    expect(boot.recently_closed?.[0].text).toContain('imagenes del reto');
  });

  it('accepts a v1 context whose pending items are plain strings', async () => {
    await fs.writeFile(
      brain.paths.activeContext(),
      JSON.stringify({
        last_session: 'session_2026-01-01',
        active_topics: [],
        pending_tasks: ['un pendiente antiguo escrito como texto'],
        last_updated: '2026-01-01T00:00:00.000Z',
      }),
      'utf-8',
    );

    const prefrontal = new Prefrontal(brain);
    const ctx = await prefrontal.getContext();
    expect(ctx.pending_tasks.length).toBe(1);
    expect((ctx.pending_tasks[0] as any).id).toMatch(/^p_/);

    const after = await prefrontal.updateContext({ resolve_pending: 'un pendiente antiguo' });
    expect(after.resolved?.length).toBe(1);
  });
});

describe('the miner enriches but does not invent', () => {
  it('skips a topic that has no neuron yet', async () => {
    const result = await cortex.learn('Juego Billar 8 Ball', 'fact', 'Mencionado en un fichero.', {
      source: 'miner',
      createIfMissing: false,
    });
    expect(result.action).toBe('skipped');
    expect(result.neuron).toBeNull();
    expect(await fileExists(brain.paths.neuron('project_juego_billar_8_ball'))).toBe(false);
  });

  it('still writes into a neuron that exists, tagged as mined', async () => {
    await cortex.learn('OctoChat', 'fact', 'Plugin de chatbot con IA.');
    const result = await cortex.learn('OctoChat', 'fact', 'Used in dashboard.js.', {
      source: 'miner',
      createIfMissing: false,
    });
    expect(result.action).toBe('updated');

    const neuron = await cortex.peek('project_octochat');
    const mined = neuron!.facts.find(f => f.text.includes('dashboard.js'));
    expect(mined?.source).toBe('miner');
  });
});
