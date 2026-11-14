// ─── crbro-memory view: editing an entry and merging neurons (2.12) ──
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { connectCaller, type ToolCaller } from '../src/cli/mcpclient.js';
import { startViewer, type Viewer } from '../src/cli/view.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let tmp: string;
let caller: ToolCaller;
let viewer: Viewer;
const savedPath = process.env.CRBRO_PATH;

function post(p: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: viewer.port, method: 'POST', path: p,
      headers: { Host: `127.0.0.1:${viewer.port}`, 'X-CRBRO-Token': viewer.token, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { let json: any = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* none */ } resolve({ status: res.statusCode ?? 0, json }); });
    });
    r.on('error', reject);
    r.end(data);
  });
}

async function must(name: string, args: Record<string, unknown>) {
  const r = await caller.call(name, args);
  if (!r.ok) throw new Error(`${name}: ${r.text}`);
  return r.data;
}

/** The entries of a neuron as crbro_inspect lists them (an index: a preview, not the whole text), retired ones included. */
async function entries(neuron: string) {
  const d = await must('crbro_inspect', { view: 'neuron', neuron, limit: 200, include_superseded: true });
  return (((d.neuron ?? d).entries ?? []) as any[]).map(e => ({ ...e, text: e.text ?? e.preview }));
}

/** One entry read in full: its keywords and rationale are here. */
async function full(neuron: string, id: string) {
  const d = await must('crbro_inspect', { view: 'neuron', neuron, entries: [id] });
  return (d.neuron ?? d).entries[0] as any;
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-view-edit-'));
  process.env.CRBRO_PATH = path.join(tmp, 'brain');
  const { createServer, createEngines } = await import('../src/server.js');
  const server = createServer(createEngines());
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  caller = await connectCaller(ct, async () => { await server.close(); });
  await must('crbro_boot', {});
  await must('crbro_learn', { topic: 'Tienda', type: 'fact', content: 'La tienda abre a las nueve.', keywords: ['horario'] });
  await must('crbro_learn', { topic: 'Tienda', type: 'pattern', content: 'Revisar el stock cada lunes.' });
  await must('crbro_learn', { topic: 'Tienda', type: 'decision', content: 'Usar Stripe para cobrar', rationale: 'Comisiones menores.' });
  await must('crbro_learn', { topic: 'Almacén', type: 'fact', content: 'El almacén está en Murcia.' });
  await must('crbro_learn', { topic: 'Almacén', type: 'debt', content: 'DEFERRED: etiquetar las cajas. REVISAR CUANDO: llegue el pedido.' });
  viewer = await startViewer({ caller, port: 0 });
});

afterAll(async () => {
  await viewer?.close();
  await caller?.close();
  if (savedPath === undefined) delete process.env.CRBRO_PATH; else process.env.CRBRO_PATH = savedPath;
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

describe('edit an entry', () => {
  it('a fact is replaced: the new text is live, the old one retired, its keywords kept', async () => {
    const old = (await entries('project_tienda')).find(e => e.kind === 'fact')!;
    const r = await post('/api/edit', { neuron: 'project_tienda', id: old.id, text: 'La tienda abre a las diez.' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const all = await entries('project_tienda');
    const fresh = all.find(e => e.kind === 'fact' && e.text === 'La tienda abre a las diez.');
    expect(fresh).toBeTruthy();
    expect((await full('project_tienda', fresh!.id)).keys).toEqual(['horario']);
    expect(all.find(e => e.id === old.id)?.status).toBeTruthy();   // retired, still in the file
  });

  it('a pattern is written new and the old text retired', async () => {
    const old = (await entries('project_tienda')).find(e => e.kind === 'pattern')!;
    const r = await post('/api/edit', { neuron: 'project_tienda', id: old.id, text: 'Revisar el stock cada martes.' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const all = await entries('project_tienda');
    expect(all.find(e => e.kind === 'pattern' && e.text === 'Revisar el stock cada martes.' && !e.status)).toBeTruthy();
    expect(all.find(e => e.kind === 'pattern' && e.text === 'Revisar el stock cada lunes.')?.status).toBeTruthy();
  });

  it('a decision keeps its rationale', async () => {
    const old = (await entries('project_tienda')).find(e => e.kind === 'decision')!;
    const r = await post('/api/edit', { neuron: 'project_tienda', id: old.id, text: 'Usar Stripe y PayPal para cobrar' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const live = (await entries('project_tienda')).find(e => e.kind === 'decision' && String(e.text).startsWith('Usar Stripe y PayPal') && !e.status);
    expect(live).toBeTruthy();
    expect((await full('project_tienda', live!.id)).rationale).toBe('Comisiones menores.');
  });

  it('refuses nothing-changed, an empty text, the map, an unknown entry and a retired one', async () => {
    const live = (await entries('project_almacen')).find(e => e.kind === 'fact')!;
    expect((await post('/api/edit', { neuron: 'project_almacen', id: live.id, text: live.text })).status).toBe(400);
    expect((await post('/api/edit', { neuron: 'project_almacen', id: live.id, text: '   ' })).status).toBe(400);
    expect((await post('/api/edit', { neuron: 'project_almacen', id: 'ffffffffffff', text: 'x' })).status).toBe(404);
    const retired = (await entries('project_tienda')).find(e => e.status)!;
    expect((await post('/api/edit', { neuron: 'project_tienda', id: retired.id, text: 'otro texto' })).status).toBe(409);
    await must('crbro_map', { neuron: 'project_almacen', content: 'Mapa del almacén.' });
    const map = (await entries('project_almacen')).find(e => e.kind === 'map')!;
    expect((await post('/api/edit', { neuron: 'project_almacen', id: map.id, text: 'otro' })).status).toBe(400);
  });

  it('a credential typed into an edit never reaches the file', async () => {
    const live = (await entries('project_almacen')).find(e => e.kind === 'fact' && !e.status)!;
    const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const r = await post('/api/edit', { neuron: 'project_almacen', id: live.id, text: `El almacén está en Murcia, token ${secret}` });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const raw = await fs.readFile(path.join(tmp, 'brain', 'cortex', 'project_almacen.json'), 'utf8');
    expect(raw).not.toContain(secret);
  });
});

describe('merge neurons', () => {
  it('previews first and writes nothing; confirming merges, deletes the source and says how to undo', async () => {
    const before = await entries('project_almacen');
    const preview = await post('/api/merge', { source: 'project_almacen', target: 'project_tienda' });
    expect(preview.status).toBe(200);
    expect(preview.json.preview.from.id).toBe('project_almacen');
    expect(preview.json.preview.into.id).toBe('project_tienda');
    expect((await entries('project_almacen')).length).toBe(before.length);   // nothing moved yet

    const done = await post('/api/merge', { source: 'project_almacen', target: 'project_tienda', confirm: true });
    expect(done.status).toBe(200);
    expect(done.json.undo).toContain('crbro_forget restore:true');
    const into = await entries('project_tienda');
    expect(into.some(e => e.kind === 'debt' && e.text.includes('etiquetar las cajas'))).toBe(true);
    const gone = await caller.call('crbro_inspect', { view: 'neuron', neuron: 'project_almacen' });
    expect(gone.ok).toBe(false);
  });

  it('refuses merging a neuron into itself and an unknown neuron', async () => {
    expect((await post('/api/merge', { source: 'project_tienda', target: 'project_tienda' })).status).toBe(400);
    expect((await post('/api/merge', { source: 'project_tienda', target: 'project_no_existe' })).status).toBe(400);
  });
});

describe('the page', () => {
  it('has the Edit button, the Merge button and both dialogs, still without innerHTML', async () => {
    const res: string = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: viewer.port, path: '/', headers: { Host: `127.0.0.1:${viewer.port}` } }, r => {
        const c: Buffer[] = []; r.on('data', x => c.push(x)); r.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
      }).on('error', reject);
    });
    expect(res).toContain('id="editDlg"');
    expect(res).toContain('id="mergeDlg"');
    expect(res).toContain("'Edit'");
    expect(res).toContain('Merge into another neuron');
    expect(res).not.toContain('innerHTML');
  });
});
