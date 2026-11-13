// ─── crbro-memory view: the page, the guards and the API ─────────
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { connectCaller, type ToolCaller } from '../src/cli/mcpclient.js';
import { startViewer, main as viewMain, type Viewer } from '../src/cli/view.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let tmp: string;
let caller: ToolCaller;
let viewer: Viewer;
const savedPath = process.env.CRBRO_PATH;

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string; json: any }

/** Raw HTTP, so every header (Host included) is exactly what the test says. */
function request(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path ?? '/',
      headers: { Host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = JSON.parse(body); } catch { /* html */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
      });
    });
    r.on('error', reject);
    if (opts.body !== undefined) r.write(opts.body);
    r.end();
  });
}

const api = (path: string, body?: unknown, headers: Record<string, string> = {}) => request(viewer.port, {
  method: body === undefined ? 'GET' : 'POST', path,
  headers: { 'X-CRBRO-Token': viewer.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function must(name: string, args: Record<string, unknown>) {
  const r = await caller.call(name, args);
  if (!r.ok) throw new Error(`${name}: ${r.text}`);
  return r.data;
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-g-view-'));
  process.env.CRBRO_PATH = path.join(tmp, 'brain');
  const { createServer, createEngines } = await import('../src/server.js');
  const server = createServer(createEngines());
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  caller = await connectCaller(ct, async () => { await server.close(); });
  await must('crbro_boot', {});
  await must('crbro_learn', { topic: 'Acme', type: 'fact', content: 'Acme deploys to port 8443.', keywords: ['puerto'] });
  await must('crbro_learn', { topic: 'Acme', type: 'pattern', content: 'Run the smoke test after each deploy.' });
  await must('crbro_learn', { topic: 'Acme', type: 'decision', content: 'Use Postgres for Acme.', rationale: 'Joins.' });
  await must('crbro_learn', { topic: 'Acme', type: 'fact', content: 'Acme staging runs PHP 8.1 on host S.', shelf_life: 'volatile' });
  await must('crbro_learn', { topic: 'Acme', type: 'fact', content: 'A line to remove for good.' });
  // Age one volatile fact past its 90-day window, as a brain a year old would hold it.
  const file = path.join(tmp, 'brain', 'cortex', 'project_acme.json');
  const n = JSON.parse(await fs.readFile(file, 'utf8'));
  n.facts.find((f: any) => f.text.includes('PHP 8.1')).added = '2025-01-02T00:00:00.000Z';
  await fs.writeFile(file, JSON.stringify(n, null, 2));
  await must('crbro_context', { add_pending: 'Send the Acme invoice' });
  await must('crbro_context', { add_pending: 'Old idea we dropped' });
  viewer = await startViewer({ caller, port: 0 });
});

afterAll(async () => {
  await viewer?.close();
  await caller?.close();
  if (savedPath === undefined) delete process.env.CRBRO_PATH; else process.env.CRBRO_PATH = savedPath;
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

describe('guards', () => {
  it('binds to 127.0.0.1 and hands out a 32-byte token in the fragment', () => {
    expect(viewer.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${viewer.port}/#t=[0-9a-f]{64}$`));
  });

  it('serves one self-contained page under a strict CSP with a fresh nonce', async () => {
    const r = await request(viewer.port);
    expect(r.status).toBe(200);
    const csp = String(r.headers['content-security-policy']);
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(r.body).toContain(`<script nonce="${nonce}">`);
    expect(r.body).toContain(`<style nonce="${nonce}">`);
    expect(r.body).not.toMatch(/<(script|link|img|iframe)[^>]+(src|href)=/i);
    expect(r.body).not.toMatch(/https?:\/\//);
    expect(r.body).not.toContain('innerHTML');
    expect(r.body).toContain('prefers-color-scheme:dark');
    expect(r.body).toContain('history.replaceState');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    const again = await request(viewer.port);
    expect(/'nonce-([^']+)'/.exec(String(again.headers['content-security-policy']))![1]).not.toBe(nonce);
  });

  it('refuses a foreign Host (DNS rebinding), a missing or wrong token, a foreign Origin', async () => {
    expect((await request(viewer.port, { headers: { Host: `evil.example:${viewer.port}` } })).status).toBe(421);
    expect((await request(viewer.port, { path: '/api/status', headers: { Host: 'localhost:1' } })).status).toBe(421);
    expect((await request(viewer.port, { path: '/api/status' })).status).toBe(401);
    expect((await api('/api/status', undefined, { 'X-CRBRO-Token': 'f'.repeat(64) })).status).toBe(401);
    expect((await api('/api/status', undefined, { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await api('/api/status', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await api('/api/status', undefined, { Origin: `http://127.0.0.1:${viewer.port}` })).status).toBe(200);
    expect((await request(viewer.port, { path: '/api/status', headers: { Host: `localhost:${viewer.port}`, 'X-CRBRO-Token': viewer.token } })).status).toBe(200);
  });

  it('writes need JSON, small bodies, known routes and methods', async () => {
    const asForm = await request(viewer.port, { method: 'POST', path: '/api/pending', headers: { 'X-CRBRO-Token': viewer.token, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'action=resolve' });
    expect(asForm.status).toBe(415);
    const big = await api('/api/pending', { action: 'resolve', id: 'p_aaaaaa', pad: 'x'.repeat(70_000) });
    expect(big.status).toBe(413);
    expect((await api('/api/nope')).status).toBe(404);
    expect((await api('/api/status', {})).status).toBe(405);
    expect((await request(viewer.port, { method: 'DELETE', path: '/' })).status).toBe(405);
    expect((await api('/api/pending', { action: 'resolve', id: 'not an id' })).status).toBe(400);
    expect((await api('/api/verify', { neuron: 'Acme', id: 'x', kind: 'map' })).status).toBe(400);
    expect((await api('/api/neuron?id=')).status).toBe(400);
  });
});

describe('features', () => {
  it('lists neurons and opens one, entries grouped with date, status, verification, freshness', async () => {
    const list = await api('/api/neurons');
    expect(list.status).toBe(200);
    expect(list.json.neurons.map((n: any) => n.id)).toContain('project_acme');
    const one = await api('/api/neuron?id=project_acme');
    const n = one.json.neuron;
    expect(n.name).toBe('Acme');
    const kinds = new Set(n.entries.map((e: any) => e.kind));
    expect([...kinds]).toEqual(expect.arrayContaining(['fact', 'pattern', 'decision']));
    for (const e of n.entries) {
      expect(e.added).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.verification).toBeTruthy();
      expect(e.freshness?.state).toBeTruthy();
    }
    const dec = n.entries.find((e: any) => e.kind === 'decision');
    const full = await api(`/api/entry?neuron=project_acme&id=${dec.id}`);
    expect(full.json.entry).toMatchObject({ text: 'Use Postgres for Acme.', rationale: 'Joins.' });
  });

  it('searches with crbro_recall', async () => {
    const r = await api('/api/search?q=' + encodeURIComponent('Acme deploy port'));
    expect(r.status).toBe(200);
    expect([...r.json.results, ...r.json.possibly_stale].map((x: any) => x.neuron_id)).toContain('project_acme');
  });

  it('resolves and discards open items', async () => {
    const before = await api('/api/pending');
    const items = before.json.open as any[];
    const invoice = items.find(t => t.text.includes('invoice'));
    const dropped = items.find(t => t.text.includes('dropped'));
    expect((await api('/api/pending', { action: 'resolve', id: invoice.id })).status).toBe(200);
    expect((await api('/api/pending', { action: 'discard', id: dropped.id })).status).toBe(200);
    const after = await api('/api/pending');
    expect(after.json.open).toHaveLength(0);
    expect(after.json.closed.map((t: any) => t.text)).toEqual(['Send the Acme invoice']);
    expect((await api('/api/pending', { action: 'resolve', id: invoice.id })).status).toBe(404);
  });

  it('shows possibly-stale entries; verify takes one off the list', async () => {
    const r = await api('/api/stale');
    expect(r.status).toBe(200);
    const row = r.json.stale.find((s: any) => s.preview.includes('PHP 8.1'));
    expect(row).toBeTruthy();
    const v = await api('/api/verify', { neuron: row.neuron_id, id: row.entry_id, kind: row.kind });
    expect(v.status).toBe(200);
    const again = await api('/api/stale');
    expect(again.json.stale.find((s: any) => s.preview.includes('PHP 8.1'))).toBeUndefined();
    const n = (await api('/api/neuron?id=project_acme')).json.neuron;
    expect(n.entries.find((e: any) => e.preview.includes('PHP 8.1')).verification.method).toBe('user');
  });

  it('retires a pattern (kept, hidden) and removes a fact for good', async () => {
    const n = (await api('/api/neuron?id=project_acme')).json.neuron;
    const pat = n.entries.find((e: any) => e.kind === 'pattern');
    expect((await api('/api/retire', { neuron: 'project_acme', id: pat.id, kind: 'pattern' })).status).toBe(200);
    const live = (await api('/api/neuron?id=project_acme')).json.neuron;
    expect(live.entries.find((e: any) => e.id === pat.id)).toBeUndefined();
    const withRetired = (await api('/api/neuron?id=project_acme&retired=1')).json.neuron;
    expect(withRetired.entries.find((e: any) => e.id === pat.id).status).toBe('superseded');

    const doomed = live.entries.find((e: any) => e.preview === 'A line to remove for good.');
    const del = await api('/api/remove', { neuron: 'project_acme', id: doomed.id });
    expect(del.status).toBe(200);
    const gone = (await api('/api/neuron?id=project_acme&retired=1')).json.neuron;
    expect(gone.entries.find((e: any) => e.id === doomed.id)).toBeUndefined();
    expect((await api('/api/remove', { neuron: 'project_acme', id: doomed.id })).status).toBe(409);
  });
});

describe('the command', () => {
  it('--help, bad flags, and a run that stops on signal and closes its server', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await viewMain(['--help'])).toBe(0);
      expect(await viewMain(['--port', 'abc'])).toBe(2);
      expect(await viewMain(['extra'])).toBe(2);
      const ac = new AbortController();
      let closed = false;
      let seen: Viewer | null = null;
      const done = viewMain(['--no-open', '--port', '0'], {
        connect: async () => ({ call: caller.call, close: async () => { closed = true; } }),
        onReady: v => { seen = v; },
        signal: ac.signal,
      });
      await vi.waitFor(() => expect(seen).not.toBeNull());
      const port = seen!.port;
      expect((await request(port, { path: '/api/status', headers: { 'X-CRBRO-Token': seen!.token } })).status).toBe(200);
      ac.abort();
      expect(await done).toBe(0);
      expect(closed).toBe(true);
      await expect(request(port)).rejects.toThrow();
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});
