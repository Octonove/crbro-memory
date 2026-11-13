// ─── 2.11: a topic lands in the neuron it names, and only there ─
//
// Reproduced on a copy of a real brain (2.10.0):
//  - "Sprint B" was saved into "Sprint A" (bigram similarity 0.857 ≥ 0.85);
//  - "C++" and "C#" both went to project_c;
//  - Japanese and Cyrillic names all went to one neuron called "project_";
//  - learn with a nonexistent neuron_id plus topic "CRBRO" wrote into
//    project_crbro without a word;
//  - topic "project_tema_nuevo_zeta" created project_project_tema_nuevo_zeta;
//  - "Juego Onoris Lanista" was typed lang_ because it contains "go ".

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { toSnakeCase, neuronId, inferNeuronType, slugCandidates } from '../src/utils/ids.js';

let root: string;
let brain: Brain;
let cortex: Cortex;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-c1-names-'));
  brain = new Brain(root);
  await brain.initialize();
  cortex = new Cortex(brain);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('different names never merge', () => {
  it('"Sprint B" does not go into "Sprint A"', async () => {
    const a = await cortex.learn('Sprint A', 'fact', 'El sprint A cierra el viernes.');
    const b = await cortex.learn('Sprint B', 'fact', 'El sprint B empieza el lunes.');
    expect(a.neuron!.id).toBe('project_sprint_a');
    expect(b.action).toBe('created');
    expect(b.neuron!.id).toBe('project_sprint_b');
    expect((await cortex.peek('project_sprint_a'))!.facts).toHaveLength(1);
  });

  it('long names one letter apart stay apart', async () => {
    await cortex.learn('Cliente Norte A', 'fact', 'Uno.');
    const r = await cortex.learn('Cliente Norte B', 'fact', 'Dos.');
    expect(r.neuron!.id).toBe('project_cliente_norte_b');
  });

  it('C, C++ and C# are three neurons', async () => {
    const c = await cortex.learn('C', 'fact', 'Punteros.');
    const cpp = await cortex.learn('C++', 'fact', 'Plantillas.');
    const cs = await cortex.learn('C#', 'fact', 'LINQ.');
    const ids = [c.neuron!.id, cpp.neuron!.id, cs.neuron!.id];
    expect(new Set(ids).size).toBe(3);
    expect(cpp.neuron!.id).toMatch(/cpp$/);
    expect(cs.neuron!.id).toMatch(/csharp$/);
    expect(toSnakeCase('Tips de C++')).toBe('tips_de_cpp');
  });

  it('names without Latin letters get distinct, stable, non-empty slugs', async () => {
    const tokio = await cortex.learn('東京', 'fact', 'Capital.');
    const osaka = await cortex.learn('大阪', 'fact', 'Comercio.');
    const ru = await cortex.learn('Москва', 'fact', 'Rio.');
    const emoji = await cortex.learn('🚀🚀', 'fact', 'Cohete.');
    const ids = [tokio, osaka, ru, emoji].map(r => r.neuron!.id);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id).not.toBe('project_');
    expect(ru.neuron!.id).toBe('project_moskva');
    expect(toSnakeCase('東京')).toBe(toSnakeCase('東京'));
    expect(toSnakeCase('東京 2026')).not.toBe(toSnakeCase('大阪 2026'));
    // The same name again finds the same neuron.
    const otra = await cortex.learn('東京', 'fact', 'Otra cosa.');
    expect(otra.neuron!.id).toBe(tokio.neuron!.id);
    expect(otra.action).toBe('updated');
  });

  it('Latin letters NFD does not split survive (ß, ø, ł)', () => {
    expect(toSnakeCase('Straße')).toBe('strasse');
    expect(toSnakeCase('Øresund')).toBe('oresund');
    expect(toSnakeCase('Łódź')).toBe('lodz');
  });

  it('a 2.10 neuron stays reachable under its old slug, but never for a hashed name', async () => {
    // 2.10 slugged "Straße" to "strae".
    await cortex.create('strae', 'project', 'general');
    const r = await cortex.learn('Straße', 'fact', 'Calle.');
    expect(r.neuron!.id).toBe('project_strae');
    expect(slugCandidates('東京')).toHaveLength(1);
  });

  it('a plural or an underscore is the same name (the only variant that resolves)', async () => {
    await cortex.learn('Widget Catalog', 'fact', 'Catalogo.');
    const r = await cortex.learn('widget catalogs', 'fact', 'Otro.');
    expect(r.neuron!.id).toBe('project_widget_catalog');
    expect(r.resolved_by).toBe('variant');
  });
});

describe('type-aware lookup', () => {
  it('prefers the neuron of the requested or implied type when several share a name', async () => {
    await cortex.create('React', 'project', 'general');
    await cortex.create('React', 'tech', 'general');
    const asked = await cortex.learn('React', 'fact', 'Hooks.', { neuronType: 'project' });
    expect(asked.neuron!.id).toBe('project_react');
    expect(asked.ambiguous).toEqual(['tech_react']);
    const implied = await cortex.learn('React', 'fact', 'JSX.');
    expect(implied.neuron!.id).toBe('tech_react');
  });
});

describe('a topic shaped like an id', () => {
  it('gets no second prefix', async () => {
    const r = await cortex.learn('project_tema_nuevo_zeta', 'fact', 'Nuevo.');
    expect(r.neuron!.id).toBe('project_tema_nuevo_zeta');
    expect(neuronId('project_x', 'project')).toBe('project_x');
    expect(neuronId('Project Alpha', 'project')).toBe('project_alpha');
  });

  it('still finds a neuron 2.10 created with the prefix twice', async () => {
    await fs.writeFile(brain.paths.neuron('project_project_viejo'), JSON.stringify({
      id: 'project_project_viejo', name: 'project_viejo', domain: 'general', type: 'project', created: '2026-01-01', last_accessed: '2026-01-01',
      access_count: 1, heat: 0.5, summary: '', facts: [], decisions: [], patterns: [], preferences: [], connections: [], tags: [],
    }));
    const r = await cortex.learn('project_viejo', 'fact', 'Sigue aqui.');
    expect(r.neuron!.id).toBe('project_project_viejo');
  });
});

describe('neuron_id that does not exist', () => {
  it('is an error naming the id, and nothing is written anywhere', async () => {
    await cortex.learn('CRBRO', 'fact', 'Memoria persistente.');
    await expect(cortex.learn('CRBRO', 'fact', 'Esto no debe caer en project_crbro.', { neuronId: 'project_crbr' }))
      .rejects.toThrow(/No neuron with id "project_crbr"/);
    const n = await cortex.peek('project_crbro');
    expect(n!.facts.map(f => f.text)).not.toContain('Esto no debe caer en project_crbro.');
    expect(await cortex.peek('project_crbr')).toBeNull();
  });
});

describe('inferNeuronType reads whole words', () => {
  it('no substring guesses', () => {
    expect(inferNeuronType('Juego Onoris Lanista')).toBe('project');
    expect(inferNeuronType('PAGO UNICO')).toBe('project');
    expect(inferNeuronType('Marketing digital')).toBe('project');
    expect(inferNeuronType('Interesante')).toBe('project');
    expect(inferNeuronType('Go')).toBe('lang');
    expect(inferNeuronType('Proyecto en Go')).toBe('lang');
    expect(inferNeuronType('Node.js tips')).toBe('tech');
    expect(inferNeuronType('Protocolo de despliegue')).toBe('protocol');
    expect(inferNeuronType('CI/CD del monorepo')).toBe('process');
  });
});
