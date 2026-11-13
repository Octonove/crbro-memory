import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { extractContent, isMinerNoise } from '../src/miner/extractor.js';

/**
 * The miner stored the first long line of a file as a fact, checklists
 * included: "- [x] Navigate to https://…" became "- x Navigate to https://…"
 * in hundreds of neurons. It now keeps sentences, and maintenance can find the
 * ones already stored — counted on a dry run, removed only when asked.
 */
const TASK_MD = [
  '# Task: check the checkout flow',
  '',
  '- [x] Navigate to https://shop.example.test/cart and add two items to the cart',
  '- [ ] Verify the shipping costs on the second step of the checkout',
  '* [x] Take a screenshot of the confirmation page for the report',
  '',
  'https://shop.example.test/checkout/confirmation?order=123456789',
  '',
].join('\n');

describe('miner extractor', () => {
  it('a checklist with no prose gives no summary instead of a checklist line', () => {
    const r = extractContent(TASK_MD, 'task.md');
    expect(r.summary).toBe('');
    for (const f of [...r.facts, ...r.decisions]) expect(isMinerNoise(f), f).toBe(false);
  });

  it('prefers the first real sentence, past headings, lists, links, code and frontmatter', () => {
    const md = [
      '---', 'title: notes', 'tags: [a, b]', '---',
      '# Deploy notes',
      '- [x] Navigate to https://console.example.test/project/settings and copy the id',
      '```', 'npm run build && firebase deploy --only hosting', '```',
      '> A quoted line that someone else wrote about something else entirely',
      'https://docs.example.test/a/very/long/link/that/is/not/a/sentence/at/all',
      'The site is deployed to Firebase Hosting from the main branch every Friday.',
    ].join('\n');
    expect(extractContent(md, 'notes.md').summary).toBe('The site is deployed to Firebase Hosting from the main branch every Friday.');
  });

  it('knows a checklist line, before and after the brackets are stripped, a bare link, a heading', () => {
    expect(isMinerNoise('- [x] Navigate to https://a.test/b')).toBe(true);
    expect(isMinerNoise('- x Navigate to https://a.test/b')).toBe(true);
    expect(isMinerNoise('* [ ] Verify the totals')).toBe(true);
    expect(isMinerNoise('https://a.test/b/c')).toBe(true);
    expect(isMinerNoise('## Findings')).toBe(true);
    expect(isMinerNoise('The API runs on Cloud Run behind a load balancer.')).toBe(false);
    expect(isMinerNoise('- the API runs on Cloud Run')).toBe(false);
  });
});

describe('maintenance finds the checklist lines the miner already stored', () => {
  let holder: string, root: string, client: Client;
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
  const body = (r: any) => JSON.parse(r.content[0].text);

  beforeAll(async () => {
    holder = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-minernoise-'));
    root = path.join(holder, 'brain');
    await fs.mkdir(root, { recursive: true });
    process.env.CRBRO_PATH = root;
    const { createServer } = await import('../src/server.js');
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer().connect(st);
    client = new Client({ name: 'miner-noise-test', version: '1.0.0' });
    await client.connect(ct);
    await call('crbro_boot');
    const r = body(await call('crbro_learn', { topic: 'Shop checkout', type: 'fact', content: 'The checkout runs on Stripe.' }));
    await call('crbro_learn', { neuron_id: r.neuron_id, type: 'fact', content: '- x Navigate to https://shop.example.test/cart' });
    await call('crbro_learn', { neuron_id: r.neuron_id, type: 'fact', content: '- x Check the totals by hand' });
    // What the miner wrote is marked source "miner"; the second line stays a person's.
    const file = path.join(root, 'cortex', `${r.neuron_id}.json`);
    const n = JSON.parse(await fs.readFile(file, 'utf8'));
    n.facts.find((f: any) => f.text.includes('Navigate')).source = 'miner';
    await fs.writeFile(file, JSON.stringify(n, null, 2));
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    delete process.env.CRBRO_PATH;
    await fs.rm(holder, { recursive: true, force: true });
  });

  it('counted on a dry run, nothing removed; removed only with purge_boilerplate; a person\'s line is never touched', async () => {
    const dry = body(await call('crbro_maintenance', { dry_run: true }));
    expect(dry.boilerplate_facts).toBe(1);
    const cortex = path.join(root, 'cortex');
    const text = async () => (await Promise.all((await fs.readdir(cortex)).map(f => fs.readFile(path.join(cortex, f), 'utf8')))).join('\n');
    expect(await text()).toContain('Navigate to https://shop.example.test/cart');
    const done = body(await call('crbro_maintenance', { purge_boilerplate: true }));
    expect(done.boilerplate_removed).toBe(1);
    expect(await text()).not.toContain('Navigate to https://shop.example.test/cart');
    expect(await text()).toContain('Check the totals by hand');
    expect(await text()).toContain('The checkout runs on Stripe.');
  });
});
