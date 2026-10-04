// ─── Shelf life, iteration 2: how the warning reaches the agent ──
//
// The first agentic measurement (PREREGISTRO.md, Fifth amendment) showed
// recall flagging the right rows and agents answering with the old value
// anyway: the warning sat at the end of a long hint, and the old value came
// back as ordinary matching_content. Iteration 2 (staleness.md §14) changes
// the presentation, not the detection:
//
//   - a short stale_warning OPENS the answer, before query and results;
//   - each possibly_stale row leads with warning and next_step, and carries
//     the stored line as last_known, never as matching_content;
//   - next_step names the file, path or URL the line itself cites, when it
//     cites one (namedSources), and otherwise says where to look and what to
//     say if checking is not possible;
//   - the hint says the order to check first; the server instructions, boot's
//     memory_discipline and learn's content parameter say the same, and learn
//     asks that a changeable value say where it came from.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { namedSources } from '../src/engine/source.js';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

describe('namedSources: what a line says it came from', () => {
  it('finds files, paths, dotfiles and URLs, in order and without duplicates', () => {
    expect(namedSources('El límite de subida es 20 MB, según config/limits.yml.')).toEqual(['config/limits.yml']);
    expect(namedSources('The staging host is set in .env.staging and in deploy/hosts.ini')).toEqual(['.env.staging', 'deploy/hosts.ini']);
    expect(namedSources('Precio del plan Básico: 12 € (tarifas.json).')).toEqual(['tarifas.json']);
    expect(namedSources('Pricing from https://example.org/pricing, checked in March.')).toEqual(['https://example.org/pricing']);
    expect(namedSources('nginx listens on 8080 (/etc/nginx/sites-enabled/app.conf)')).toEqual(['/etc/nginx/sites-enabled/app.conf']);
    expect(namedSources('Build args live in the Dockerfile and docker-compose.yml')).toEqual(['Dockerfile', 'docker-compose.yml']);
    expect(namedSources('Ruta: C:\\apps\\billing\\settings.ini')).toEqual(['C:\\apps\\billing\\settings.ini']);
    expect(namedSources('El token va en `.env`, nunca en el código.')).toEqual(['.env']);
    // A file named twice, or inside a path already kept, counts once.
    expect(namedSources('See docs/team.md; docs/team.md lists the leads.')).toEqual(['docs/team.md']);
  });

  it('names nothing when the line cites no file, path or URL', () => {
    for (const text of [
      'El panel de administración escucha en el puerto 9090.',
      'Velocidad máxima 30 km/h, soporte 24/7, 29 €/mes y/o descuentos.',
      'Producción corre sobre Node.js 22 y Next.js 15.',
      'La API está en api.example.com desde la migración.',     // a host is the value, not where it came from
      'Versión 2.8.0 publicada, p.ej. con TCP/IP y input/output.',
      'Lo dijo Antonio en la reunión del lunes.',
      '',
    ]) expect(namedSources(text), text).toEqual([]);
  });
});

const body = (r: any) => JSON.parse(r.content[0].text);

describe('recall frames a possibly_stale row as a last-known value to check', () => {
  let holder: string;
  let root: string;
  let client: Client;
  const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
  const json = async (name: string, args: Record<string, unknown> = {}) => body(await call(name, args));

  const CITED = 'El límite de subida de ficheros de Garza es 20 MB, fijado en config/limits.yml.';
  const BARE = 'El panel de administración de Garza escucha en el puerto 7070.';
  const FRESH = 'Garza es el servicio de inventario y se despliega con Docker Compose.';
  let garza: string;

  beforeAll(async () => {
    holder = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-framing-'));
    root = path.join(holder, 'brain');
    await fs.mkdir(root, { recursive: true });
    process.env.CRBRO_PATH = root;
    const { createServer } = await import('../src/server.js');
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer().connect(st);
    client = new Client({ name: 'framing-test', version: '1.0.0' });
    await client.connect(ct);
    await call('crbro_boot');
    garza = (await json('crbro_learn', { topic: 'Garza', type: 'fact', content: FRESH, keywords: ['inventario'] })).neuron_id;
    await call('crbro_learn', { neuron_id: garza, type: 'fact', content: CITED, keywords: ['upload', 'tamaño'], shelf_life: 'volatile' });
    await call('crbro_learn', { neuron_id: garza, type: 'fact', content: BARE, keywords: ['admin'], shelf_life: 'volatile' });
    const file = path.join(root, 'cortex', `${garza}.json`);
    const n = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const f of n.facts) if (f.text === CITED || f.text === BARE) f.added = ago(150);
    await fs.writeFile(file, JSON.stringify(n, null, 2));
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    delete process.env.CRBRO_PATH;
    await fs.rm(holder, { recursive: true, force: true });
  });

  afterEach(() => { delete process.env.CRBRO_STALENESS; });

  it('opens with stale_warning, before query and results', async () => {
    const r = await call('crbro_recall', { query: 'límite subida ficheros Garza' });
    const text: string = r.content[0].text;
    expect(Object.keys(JSON.parse(text))[0]).toBe('stale_warning');
    const out = JSON.parse(text);
    expect(out.stale_warning).toMatch(/^1 matching row is in possibly_stale, the best match: a last-known value, /);
    expect(out.stale_warning).toContain('unchecked for 150 days');
    expect(out.stale_warning).toContain('Do not answer with it as current');
    expect(out.stale_warning).toContain('say it may be out of date');
    expect(text.indexOf('stale_warning')).toBeLessThan(text.indexOf('"query"'));
    expect(r.structuredContent.stale_warning).toBe(out.stale_warning);
  });

  it('a row leads with warning and next_step, then the line as last_known', async () => {
    const out = await json('crbro_recall', { query: 'límite subida ficheros Garza' });
    const row = out.possibly_stale[0];
    expect(Object.keys(row).slice(0, 3)).toEqual(['warning', 'next_step', 'last_known']);
    expect(row.last_known).toBe(CITED);
    expect(row.matching_content).toBeUndefined();
    expect(row.warning).toBe(`last known value, unverified for 150 days (since ${ago(150).slice(0, 10)}): may have changed`);
    // The line cites its source: the next step is to open it.
    expect(row.next_step).toMatch(/^Before answering, open config\/limits\.yml \(named in this entry\) and answer with what it says now\./);
    expect(row.next_step).toContain(`say this value is from ${ago(150).slice(0, 10)} and may be out of date`);
    // What the row always carried is still there.
    expect(row).toMatchObject({ neuron_id: garza, age_days: 150, shelf_life: 'volatile', shelf_inferred: false });
    expect(row.entry_id).toBeTruthy();
  });

  it('a line that names no source gets the general next step', async () => {
    const out = await json('crbro_recall', { query: 'panel administración Garza puerto' });
    const row = out.possibly_stale.find((x: any) => x.last_known === BARE);
    expect(row.next_step).toMatch(/^Before answering, look for the current value where it lives: the project's files or config if you can read them, or the user\./);
    expect(row.next_step).toContain('do not state it as current');
  });

  it('the hint puts the order to check before the general advice', async () => {
    // A second neuron with a current line on the same subject: a mixed answer.
    await call('crbro_learn', { topic: 'Albatros', type: 'fact', content: 'El límite de subida de ficheros de Albatros es 50 MB.', keywords: ['upload'] });
    const out = await json('crbro_recall', { query: 'límite subida ficheros', limit: 5 });
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.possibly_stale.length).toBeGreaterThan(0);
    const h: string = out.hint;
    expect(h).toContain('possibly_stale holds last-known values that may have changed: do not answer with one as current');
    expect(h.indexOf('do not answer with one as current')).toBeLessThan(h.indexOf('weak: verify'));
    expect(h).toContain('If you cannot check, say it may be out of date.');
    // Two stale rows (two neurons): the warning speaks in the plural, with the youngest age.
    const other = (await json('crbro_learn', { topic: 'Cormorán', type: 'fact', content: 'El límite de subida de ficheros de Cormorán es 5 MB.', keywords: ['upload'], shelf_life: 'volatile' })).neuron_id;
    const file = path.join(root, 'cortex', `${other}.json`);
    const n = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const f of n.facts) f.added = ago(300);
    await fs.writeFile(file, JSON.stringify(n, null, 2));
    const two = await json('crbro_recall', { query: 'límite subida ficheros', limit: 5 });
    expect(two.possibly_stale_count).toBe(2);
    expect(two.stale_warning).toMatch(/^2 matching rows are in possibly_stale(, the best match among them)?: last-known values, unchecked for 150\+ days, that may have changed\. Do not answer with one as current\. Check it first \(each row's next_step says where\)/);
  });

  it('a fresh answer has no new field, and the kill switch removes them all', async () => {
    const fresh = await json('crbro_recall', { query: 'Docker Compose inventario' });
    expect(fresh.results[0].matching_content).toBe(FRESH);
    expect(fresh.stale_warning).toBeUndefined();
    expect(fresh.possibly_stale).toBeUndefined();

    process.env.CRBRO_STALENESS = '0';
    const off = await json('crbro_recall', { query: 'límite subida ficheros Garza' });
    expect(off.stale_warning).toBeUndefined();
    expect(off.possibly_stale).toBeUndefined();
    expect(off.results[0].matching_content).toBe(CITED);
  });

  it('instructions, boot, learn and recall say the same thing', async () => {
    expect(client.getInstructions()).toContain('is a last-known value that may have changed: before answering with it, check it where it lives');
    expect(client.getInstructions()).toContain('never state it as current');
    const boot = await json('crbro_boot');
    expect(boot.memory_discipline).toContain('a last-known value that may have changed');
    expect(boot.memory_discipline).toContain('should say where it came from');
    const tools = (await client.listTools()).tools as any[];
    const learn = tools.find(t => t.name === 'crbro_learn');
    expect(learn.description).toContain('A value that can change names its source (file, key, URL, person).');
    expect(learn.inputSchema.properties.content.description).toContain('say where it came from');
    const recall = tools.find(t => t.name === 'crbro_recall');
    expect(recall.description).toContain('possibly_stale as last_known with a next_step');
    expect(recall.outputSchema.properties).toHaveProperty('stale_warning');
    for (const t of tools) expect(t.description.length, t.name).toBeLessThan(1000);
  });
});
