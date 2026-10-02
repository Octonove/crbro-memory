// ─── P5 phase B (2.7): boot knows which project the session is in ───
//
// Hot topics are the brain's warmest neurons, whatever the session is about:
// opening a session in one repo served ten topics from five others, and the
// repo's own neuron came only if it happened to be warm. crbro_boot now takes
// an optional `project` — the folder or repo name — and puts that project's
// neurons first. Without it, boot is byte for byte what it was.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { SearchEngine, projectSlugOf } from '../src/search/index.js';

describe('projectSlugOf', () => {
  it('takes the last segment of a path, a repo or a remote', () => {
    expect(projectSlugOf('C:/Users/x/Desktop/proyectos/Desarrollo IDEAS/crbro-memory')).toBe('crbro-memory');
    expect(projectSlugOf('C:\\Users\\x\\code\\crbro-memory\\')).toBe('crbro-memory');
    expect(projectSlugOf('/home/x/code/invokard-plugin/')).toBe('invokard-plugin');
    expect(projectSlugOf('octonove/invokard-plugin')).toBe('invokard-plugin');
    expect(projectSlugOf('https://github.com/octonove/crbro-memory.git')).toBe('crbro-memory');
    expect(projectSlugOf('git@github.com:octonove/crbro-memory.git')).toBe('crbro-memory');
    expect(projectSlugOf('Synthetica Decks')).toBe('Synthetica Decks');
    expect(projectSlugOf('   ')).toBe('');
  });
});

describe('SearchEngine.projectNeurons', () => {
  let root: string;
  let cortex: Cortex;
  let engine: SearchEngine;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-project-'));
    process.env.CRBRO_SEMANTIC = '0';
    const brain = new Brain(root);
    await brain.initialize();
    cortex = new Cortex(brain);
    engine = new SearchEngine(brain);
    await engine.init();
    cortex.setIndexer(n => engine.indexNeuron(n));

    await cortex.learn('CRBRO Memory', 'fact', 'Servidor MCP de memoria persistente.');                // name, exact
    await cortex.learn('Invokard', 'fact', 'Biblioteca de cartas de especialistas.');                // name, leading word of invokard-plugin
    await cortex.setMap('Publicacion paquete', 'El repo vive en C:/code/crbro-memory y se publica con npm publish.'); // map
    await cortex.learn('Releases', 'fact', 'Las versiones salen los domingos.', { keys: ['crbro-memory', 'release'] }); // keys
    await cortex.learn('Memory tricks', 'fact', 'Tecnicas de memoria para estudiar.');               // shares a word, not the project
    await cortex.learn('Crbro notas sueltas', 'fact', 'Notas que mencionan crbro de pasada.');       // shares the first word, not the project
  });

  afterEach(async () => {
    delete process.env.CRBRO_SEMANTIC;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('finds the project by name, map and keys, name first', async () => {
    const r = await engine.projectNeurons('C:/Users/x/crbro-memory');
    expect(r.map(x => [x.id, x.match])).toEqual([
      ['project_crbro_memory', 'name'],
      ['project_publicacion_paquete', 'map'],
      ['project_releases', 'keys'],
    ]);
  });

  it('matches a neuron named after the project\'s leading words', async () => {
    const r = await engine.projectNeurons('octonove/invokard-plugin');
    expect(r.map(x => x.id)).toEqual(['project_invokard']);
    expect(r[0].match).toBe('name');
  });

  it('returns nothing for an unknown project or one too short to mean anything', async () => {
    expect(await engine.projectNeurons('/code/otro-repo')).toEqual([]);
    expect(await engine.projectNeurons('ab')).toEqual([]);
    expect(await engine.projectNeurons('')).toEqual([]);
  });

  it('caps the list and never names a neuron that is gone', async () => {
    await cortex.forgetNeuron('project_releases');
    const r = await engine.projectNeurons('crbro-memory', 2);
    expect(r).toHaveLength(2);
    expect(r.map(x => x.id)).not.toContain('project_releases');
  });
});

describe('crbro_boot project (over MCP)', () => {
  let root: string;
  let client: Client;
  const body = (r: any) => JSON.parse(r.content[0].text);
  const boot = async (args: Record<string, unknown> = {}) =>
    body(await client.callTool({ name: 'crbro_boot', arguments: args }));

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-boot-project-'));
    process.env.CRBRO_PATH = root;   // before the import: never the user's brain
    process.env.CRBRO_SEMANTIC = '0';
    const { createServer } = await import('../src/server.js');
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer().connect(st);
    client = new Client({ name: 'boot-project', version: '0.0.0' });
    await client.connect(ct);
    await boot();

    const learn = (topic: string, content: string) =>
      client.callTool({ name: 'crbro_learn', arguments: { topic, type: 'fact', content } });
    for (let i = 0; i < 12; i++) await learn(`Tema caliente ${i}`, `Hecho del tema caliente numero ${i}.`);
    await learn('Synthetica Decks', 'El mazo de cartas vive en synthetica-decks.');

    // Hot topics as the heat engine would leave them: the project is the coldest.
    const brain = new Brain(root);
    const topics = [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `project_tema_caliente_${i}`, name: `Tema caliente ${i}`, heat: 0.9 - i * 0.01, last_access: '2026-09-30T10:00:00.000Z', domain: 'general' })),
      { id: 'project_synthetica_decks', name: 'Synthetica Decks', heat: 0.1, last_access: '2026-09-01T10:00:00.000Z', domain: 'general' },
    ];
    await fs.writeFile(brain.paths.hotTopics(), JSON.stringify({ topics, last_recalculated: '2026-09-30T10:00:00.000Z' }));
  }, 60_000);

  afterAll(async () => {
    await client.close();
    delete process.env.CRBRO_PATH;
    delete process.env.CRBRO_SEMANTIC;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('without project, boot is what it was: no new field, heat order', async () => {
    const b = await boot();
    expect(b).not.toHaveProperty('project_neurons');
    expect(b).not.toHaveProperty('project_hint');
    expect(b.hot_topics).toHaveLength(10);
    expect(b.hot_topics[0].id).toBe('project_tema_caliente_0');
    expect(b.hot_topics.map((h: any) => h.id)).not.toContain('project_synthetica_decks');
  });

  it('with project, that project leads hot_topics and is listed in project_neurons', async () => {
    const b = await boot({ project: 'C:\\code\\synthetica-decks' });
    expect(b.project_neurons).toEqual([
      { id: 'project_synthetica_decks', name: 'Synthetica Decks', match: 'name', heat: expect.any(Number) },
    ]);
    expect(b.hot_topics).toHaveLength(10);
    expect(b.hot_topics[0].id).toBe('project_synthetica_decks');
    expect(b.hot_topics[1].id).toBe('project_tema_caliente_0');   // the rest keep their heat order
  });

  it('an unknown project says so, and leaves the order alone', async () => {
    const b = await boot({ project: 'repo-que-no-existe' });
    expect(b.project_neurons).toEqual([]);
    expect(b.project_hint).toContain('repo-que-no-existe');
    expect(b.hot_topics[0].id).toBe('project_tema_caliente_0');
  });

  it('a blank project is the same as none', async () => {
    const b = await boot({ project: '   ' });
    expect(b).not.toHaveProperty('project_neurons');
  });
});
