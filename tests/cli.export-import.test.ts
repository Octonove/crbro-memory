// ─── export and import against real brains ───────────────────────
//
// Every brain is a temp folder; the servers run in-process over an in-memory
// MCP pair, the same tool surface import talks to when it spawns dist/index.js.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { connectCaller, type ToolCaller } from '../src/cli/mcpclient.js';
import { runExport, readBrain, main as exportMain } from '../src/cli/export.js';
import { buildPlan, executePlan, main as importMain } from '../src/cli/import.js';
import { parseFrontmatter } from '../src/cli/markdown.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
let tmp: string;
const savedPath = process.env.CRBRO_PATH;

/** A fresh brain at `root` with its own engines and an in-process server. */
async function open(root: string, boot = true): Promise<ToolCaller> {
  process.env.CRBRO_PATH = root;
  const { createServer, createEngines } = await import('../src/server.js');
  const engines = createEngines();
  const server = createServer(engines);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const caller = await connectCaller(ct, async () => { await server.close(); });
  if (boot) await must(caller, 'crbro_boot', {});
  return caller;
}

async function must(c: ToolCaller, name: string, args: Record<string, unknown>) {
  const r = await c.call(name, args);
  if (!r.ok) throw new Error(`${name}: ${r.text}`);
  return r.data;
}

const quiet = () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let o = '', e = '';
  const grab = () => { o += log.mock.calls.flat().join('\n'); e += err.mock.calls.flat().join('\n'); log.mockClear(); err.mockClear(); };
  return { out: () => { grab(); return o; }, err: () => { grab(); return e; }, restore: () => { grab(); log.mockRestore(); err.mockRestore(); } };
};

let brainA: string;
let a: ToolCaller;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-g-ideas-'));
  brainA = path.join(tmp, 'brain-a');
  a = await open(brainA);
  await must(a, 'crbro_learn', { topic: 'Acme', type: 'fact', content: 'Acme deploys to port 8443.', keywords: ['puerto', 'deploy'], domain: 'clients', shelf_life: 'volatile' });
  await must(a, 'crbro_learn', { topic: 'Acme', type: 'fact', content: 'Acme used port 7000 before 2025.', temporal: 'historical' });
  await must(a, 'crbro_learn', { topic: 'Acme', type: 'fact', content: 'Acme runs on PHP 5.' });
  await must(a, 'crbro_revise', { neuron: 'Acme', facts: ['Acme runs on PHP 5.'], status: 'retracted', note: 'wrong' });
  await must(a, 'crbro_learn', { topic: 'Acme', type: 'decision', content: 'Use Postgres for Acme.', rationale: 'Joins everywhere.' });
  await must(a, 'crbro_learn', { topic: 'Acme', type: 'pattern', content: 'Run the smoke test after each deploy.' });
  await must(a, 'crbro_learn', { topic: 'Acme', type: 'preference', content: 'The client prefers email over calls.' });
  await must(a, 'crbro_learn', { topic: 'Acme', type: 'error', content: 'Deployed without the env file; fixed by copying .env.example.' });
  await must(a, 'crbro_learn', { topic: 'Acme', type: 'debt', content: 'DEFERRED: CDN. CEILING: slow images. REVISIT WHEN: traffic doubles.' });
  await must(a, 'crbro_map', { neuron: 'Acme', content: 'Web on host A, DB on host B. Trap: the cron runs as root.' });
  await must(a, 'crbro_revise', { neuron: 'Acme', summary: 'Hardware storefront client.', tags: ['client', 'web'] });
  await must(a, 'crbro_learn', { topic: 'Postgres', type: 'fact', content: 'Postgres 16 is the default for new projects.', domain: 'tech' });
  await must(a, 'crbro_connect', { from: 'project_acme', to: 'tech_postgres', type: 'dependency', strength: 0.8, context: 'Acme stores orders in it' });
  await must(a, 'crbro_learn', { topic: 'Writing style protocol', type: 'fact', content: 'Answer in the language the user writes in.' });
  await must(a, 'crbro_revise', { neuron: 'Writing style protocol', name: 'Writing style', tags: ['priority:9', 'source:test'] });
  await must(a, 'crbro_context', { add_pending: 'Send the Acme invoice before Friday' });
  await must(a, 'crbro_consolidate', { summary: 'Set up Acme and its database.' });
  // A credential written straight to disk, the way an old brain may hold one:
  // learn would have redacted it, the export must too.
  const file = path.join(brainA, 'cortex', 'project_acme.json');
  const n = JSON.parse(await fs.readFile(file, 'utf8'));
  n.patterns.push(`The CI token is ${SECRET} for now.`);
  await fs.writeFile(file, JSON.stringify(n, null, 2));
});

afterAll(async () => {
  await a?.close();
  if (savedPath === undefined) delete process.env.CRBRO_PATH; else process.env.CRBRO_PATH = savedPath;
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

describe('export', () => {
  it('writes an Obsidian vault: frontmatter, kinds, wiki links, domains, day logs, open items — and redacts', async () => {
    const before = await snapshot(brainA);
    const out = path.join(tmp, 'vault');
    const r = await runExport({ brainRoot: brainA, out, format: 'md', includeRetired: false });
    expect(await snapshot(brainA)).toEqual(before);               // read-only, byte for byte
    expect(r.data.redactions).toBeGreaterThanOrEqual(1);

    const note = await fs.readFile(path.join(out, 'neurons', 'project_acme.md'), 'utf8');
    const fm = parseFrontmatter(note);
    expect(fm.data).toMatchObject({ id: 'project_acme', name: 'Acme', type: 'project', domain: 'clients', tags: ['client', 'web'] });
    expect(typeof fm.data.heat).toBe('number');
    expect(fm.data.created).toMatch(/^\d{4}-/);
    expect(fm.data.updated).toMatch(/^\d{4}-/);
    for (const h of ['## Map', '## Errors', '## Debts', '## Preferences', '## Patterns', '## Decisions', '## Facts', '## Synapses']) expect(note).toContain(h);
    expect(note).toContain('> Hardware storefront client.');
    expect(note).toMatch(/`fact` · id `[0-9a-f]{12}` · \d{4}-\d{2}-\d{2} · active · unverified · keywords: puerto, deploy · shelf life: volatile/);
    expect(note).toContain('**Why:** Joins everywhere.');
    // consolidate strengthened it and linked what the session wrote together: all kept.
    expect(note).toMatch(/\[\[tech_postgres\|Postgres\]\] — dependency · strength 0\.\d\d · Acme stores orders in it/);
    expect(note).toContain('[[index_clients|clients]]');
    expect(note).not.toContain('PHP 5');                         // retired: left out by default
    expect(note).not.toContain(SECRET);
    expect(note).toContain('[REDACTED: GitHub token]');

    const all = await readAll(out);
    expect(all).not.toContain(SECRET);
    expect(await fs.readFile(path.join(out, 'domains', 'index_clients.md'), 'utf8')).toContain('[[project_acme|Acme]]');
    const sessions = await fs.readdir(path.join(out, 'sessions'));
    expect(sessions.length).toBe(1);
    expect(await fs.readFile(path.join(out, 'sessions', sessions[0]), 'utf8')).toContain('Set up Acme and its database.');
    expect(await fs.readFile(path.join(out, 'open-items.md'), 'utf8')).toContain('- [ ] Send the Acme invoice before Friday');
    expect(JSON.parse(await fs.readFile(path.join(out, '.crbro-export.json'), 'utf8')).format).toBe('crbro-export-md');
  });

  it('--include-retired marks retired entries; json is a faithful dump, redacted', async () => {
    const out = path.join(tmp, 'vault-retired');
    await runExport({ brainRoot: brainA, out, format: 'md', includeRetired: true });
    const note = await fs.readFile(path.join(out, 'neurons', 'project_acme.md'), 'utf8');
    expect(note).toMatch(/Acme runs on PHP 5\./);
    expect(note).toContain('**retracted** (wrong)');

    const jout = path.join(tmp, 'json');
    await runExport({ brainRoot: brainA, out: jout, format: 'json', includeRetired: false });
    const raw = await fs.readFile(path.join(jout, 'crbro-export.json'), 'utf8');
    expect(raw).not.toContain(SECRET);
    const data = JSON.parse(raw);
    expect(data.format).toBe('crbro-export');
    const acme = data.neurons.find((n: any) => n.id === 'project_acme');
    expect(acme.facts.map((f: any) => f.text)).not.toContain('Acme runs on PHP 5.');
    expect(acme.map.text).toContain('cron runs as root');
    // The redacted pattern keeps its date: the sidecar moved with the new id.
    const red = acme.patterns.find((p: string) => p.includes('[REDACTED'));
    expect(red).toBeTruthy();
    expect(data.synapses).toHaveLength((await readBrain(brainA)).synapses.length);
    expect(data.context.pending_tasks[0].text).toContain('Acme invoice');
  });

  it('refuses the brain folder, a non-empty folder, bad flags; --help exits 0', async () => {
    await expect(runExport({ brainRoot: brainA, out: path.join(brainA, 'exports'), format: 'md', includeRetired: false }))
      .rejects.toThrow(/inside the brain/);
    await expect(runExport({ brainRoot: brainA, out: brainA, format: 'json', includeRetired: false })).rejects.toThrow(/inside the brain/);
    const full = path.join(tmp, 'full');
    await fs.mkdir(full);
    await fs.writeFile(path.join(full, 'x.txt'), 'x');
    await expect(runExport({ brainRoot: brainA, out: full, format: 'md', includeRetired: false })).rejects.toThrow(/not empty/);
    await expect(runExport({ brainRoot: path.join(tmp, 'nope'), out: path.join(tmp, 'n'), format: 'md', includeRetired: false })).rejects.toThrow(/no brain/);
    const q = quiet();
    try {
      expect(await exportMain(['--help'])).toBe(0);
      expect(q.out()).toContain('--include-retired');
      expect(await exportMain(['--format', 'xml'])).toBe(2);
      expect(await exportMain(['--out', path.join(brainA, 'x')])).toBe(1);   // CRBRO_PATH points at brainA
      expect(q.err()).toContain('inside the brain');
    } finally { q.restore(); }
  });
});

describe('import', () => {
  it('a JSON export round-trips into a fresh brain, and twice adds nothing', async () => {
    const plan = await buildPlan(path.join(tmp, 'json'));
    expect(plan.sourceKind).toBe('crbro-json');
    const b = await open(path.join(tmp, 'brain-b'));
    try {
      const dry = await executePlan(b, plan, false);
      expect(dry.learned).toBe(0);
      expect((await must(b, 'crbro_inspect', { view: 'neurons' })).neurons.total).toBe(0);
      expect(dry.topics.find(t => t.topic === 'Acme')!.fresh.length).toBe(9);   // 2 live facts, decision, 2 patterns, pref, error, debt, map

      const first = await executePlan(b, plan, true);
      expect(first.failures).toEqual([]);
      expect(first.connected).toBe(plan.synapses.length);
      const acme = (await must(b, 'crbro_inspect', { view: 'neuron', neuron: 'Acme', limit: 100 })).neuron;
      expect(acme.id).toBe('project_acme');
      expect(acme.domain).toBe('clients');
      expect(acme.summary).toBe('Hardware storefront client.');
      expect(acme.tags).toEqual(['client', 'web']);
      expect(acme.counts).toMatchObject({ fact: 2, decision: 1, pattern: 2, preference: 1, error: 1, debt: 1, map: 1 });
      expect(acme.connections.find((c: any) => c.target_id === 'tech_postgres')).toMatchObject({ type: 'dependency', context: 'Acme stores orders in it' });
      const full = (await must(b, 'crbro_inspect', { view: 'neuron', neuron: 'project_acme', detail: 'full' })).neuron;
      expect(full.facts.find((f: any) => f.text.includes('8443')).keys).toEqual(expect.arrayContaining(['puerto', 'deploy']));
      expect(full.decisions[0].rationale).toBe('Joins everywhere.');
      expect(JSON.stringify(full)).not.toContain(SECRET);
      // The protocol came back as a protocol, under its own name.
      const boot = await must(b, 'crbro_boot', {});
      expect(JSON.stringify(boot)).toContain('Answer in the language the user writes in.');
      const proto = (await must(b, 'crbro_inspect', { view: 'neuron', neuron: 'protocol_writing_style_protocol' })).neuron;
      expect(proto.name).toBe('Writing style');
      expect(proto.tags).toEqual(['priority:9', 'source:test']);

      const fileBefore = await snapshot(path.join(tmp, 'brain-b', 'cortex'));
      const second = await executePlan(b, plan, true);
      expect(second.learned + second.maps + second.connected).toBe(0);
      expect(second.topics.every(t => t.fresh.length === 0)).toBe(true);
      expect(await snapshot(path.join(tmp, 'brain-b', 'cortex'))).toEqual(fileBefore);  // not even a counter moved
    } finally { await b.close(); }
  });

  it('the Markdown vault round-trips too', async () => {
    const plan = await buildPlan(path.join(tmp, 'vault'));
    expect(plan.sourceKind).toBe('crbro-md');
    expect(plan.synapses).toHaveLength((await readBrain(brainA)).synapses.length);
    const c = await open(path.join(tmp, 'brain-c'));
    try {
      const r = await executePlan(c, plan, true);
      expect(r.failures).toEqual([]);
      const acme = (await must(c, 'crbro_inspect', { view: 'neuron', neuron: 'Acme' })).neuron;
      expect(acme.counts).toMatchObject({ fact: 2, decision: 1, pattern: 2, preference: 1, error: 1, debt: 1, map: 1 });
      expect(acme.summary).toBe('Hardware storefront client.');
      expect(acme.connections.map((x: any) => x.target_id)).toContain('tech_postgres');
      const again = await executePlan(c, plan, true);
      expect(again.learned + again.maps + again.connected).toBe(0);
    } finally { await c.close(); }
  });

  it('into the brain it came from, nothing is added (retired stays retired)', async () => {
    const plan = await buildPlan(path.join(tmp, 'vault-retired'));
    expect(plan.skippedRetired).toBeGreaterThanOrEqual(1);
    const r = await executePlan(a, plan, false);
    // Only the line that holds a raw credential on disk differs: its redacted
    // telling is new to this brain. Everything else, retired included, is there.
    expect(r.topics.flatMap(t => t.fresh.map(e => e.text))).toEqual(['The CI token is [REDACTED: GitHub token] for now.']);
  });

  it('a CLAUDE.md: headings → topics, dry run by default, --topic and --type, idempotent', async () => {
    const dir = path.join(tmp, 'acme-site');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'CLAUDE.md');
    await fs.writeFile(file, '# Acme site\r\n\r\nShop front.\r\n\r\n## Commands\r\n\r\n- `npm test` runs vitest\r\n- Deploy key is ' + SECRET + '\r\n');
    const d = await open(path.join(tmp, 'brain-d'));
    try {
      const q = quiet();
      let code: number;
      try { code = await importMain([file], { connect: async () => ({ call: d.call, close: async () => undefined }) }); } finally { q.restore(); }
      expect(code).toBe(0);
      expect(q.out()).toContain('Dry run');
      expect(q.out()).toContain('"Acme site — Commands" (new neuron): 2 new');
      expect(q.out()).not.toContain(SECRET);
      expect((await must(d, 'crbro_inspect', { view: 'neurons' })).neurons.total).toBe(0);

      const plan = await buildPlan(file, { topic: 'Acme notes', type: 'pattern' });
      expect(plan.topics).toHaveLength(1);
      expect(plan.topics[0].entries.every(e => e.kind === 'pattern')).toBe(true);
      const r = await executePlan(d, plan, true);
      expect(r.learned).toBe(3);
      const n = (await must(d, 'crbro_inspect', { view: 'neuron', neuron: 'Acme notes' })).neuron;
      expect(n.counts.pattern).toBe(3);
      expect(JSON.stringify(n)).not.toContain(SECRET);
      expect((await executePlan(d, plan, true)).learned).toBe(0);
    } finally { await d.close(); }
  });

  it('a Claude Code memory folder: types mapped, MEMORY.md skipped, one topic per project', async () => {
    const mem = path.join(tmp, 'home', '.claude', 'projects', 'C--Users-me-Desktop-Shop', 'memory');
    await fs.mkdir(mem, { recursive: true });
    await fs.writeFile(path.join(mem, 'MEMORY.md'), '- [Role](role.md) — who\n');
    await fs.writeFile(path.join(mem, 'role.md'), '---\nname: Role\ndescription: who the user is\nmetadata:\n  type: user\n---\nSenior PHP developer, prefers short answers.\n');
    await fs.writeFile(path.join(mem, 'no-reformat.md'), '---\nname: No reformat\ndescription: rule\nmetadata:\n  type: feedback\n---\nNever reformat files you did not change.\n\n**Why:** noisy diffs.\n');
    await fs.writeFile(path.join(mem, 'deploy.md'), '---\nname: Deploy\ndescription: where it runs\ntype: project\n---\nProduction is on host B.\n');
    await fs.writeFile(path.join(mem, 'docs.md'), '---\nname: Docs\ndescription: where the docs are\nmetadata:\n  type: reference\n---\n');
    const plan = await buildPlan(mem);
    expect(plan.sourceKind).toBe('claude-memory');
    expect(plan.topics.map(t => t.topic)).toEqual(['Shop (Claude Code memory)']);
    const kinds = Object.fromEntries(plan.topics[0].entries.map(e => [e.text.split(':')[0], e.kind]));
    expect(kinds).toEqual({ Deploy: 'fact', Docs: 'fact', 'No reformat': 'pattern', Role: 'preference' });
    expect(plan.topics[0].entries.find(e => e.text.startsWith('No reformat'))!.text).toContain('**Why:** noisy diffs.');
    expect(plan.topics[0].entries.find(e => e.text.startsWith('Docs'))!.text).toBe('Docs: where the docs are');
    expect(() => buildPlan(mem, { type: 'fact' })).not.toThrow();
    const typed = await buildPlan(mem, { type: 'fact' });
    expect(typed.topics[0].entries.every(e => e.kind === 'fact')).toBe(true);
    // A single memory file works too.
    const one = await buildPlan(path.join(mem, 'role.md'));
    expect(one.topics[0].entries).toEqual([{ kind: 'preference', text: 'Role: Senior PHP developer, prefers short answers.' }]);
  });

  it('refuses what it cannot read, and an uninitialized brain on --apply', async () => {
    await expect(buildPlan(path.join(tmp, 'missing.md'))).rejects.toThrow(/does not exist/);
    await fs.writeFile(path.join(tmp, 'not-export.json'), '{"hello":1}');
    await expect(buildPlan(path.join(tmp, 'not-export.json'))).rejects.toThrow(/not a CRBRO export/);
    await expect(buildPlan(path.join(tmp, 'json'), { topic: 'x' })).rejects.toThrow(/Markdown sources/);
    const empty = path.join(tmp, 'empty-dir');
    await fs.mkdir(empty);
    await expect(buildPlan(empty)).rejects.toThrow(/not a CRBRO export or a Claude Code memory folder/);
    const fresh = await open(path.join(tmp, 'brain-uninit'), false);
    try {
      const plan = await buildPlan(path.join(tmp, 'json'));
      await expect(executePlan(fresh, plan, true)).rejects.toThrow(/not been initialized/);
      await expect(fs.stat(path.join(tmp, 'brain-uninit', 'cortex'))).rejects.toThrow();
    } finally { await fresh.close(); }
    const q = quiet();
    try {
      expect(await importMain([])).toBe(2);
      expect(await importMain(['x', '--type', 'debt'])).toBe(2);
      expect(await importMain(['--help'])).toBe(0);
      expect(q.out()).toContain('feedback → pattern');
    } finally { q.restore(); }
  });
});

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '.search') await walk(p); } else out[path.relative(dir, p)] = await fs.readFile(p, 'utf8');
    }
  };
  await walk(dir);
  return out;
}

async function readAll(dir: string): Promise<string> {
  return Object.values(await snapshot(dir)).join('\n');
}

