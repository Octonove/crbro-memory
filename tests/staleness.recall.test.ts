// ─── Shelf life through the tools: learn, revise, recall, inspect ─
//
// The feedback this answers: a value that changed in the world and that
// nobody retired from memory (a port, a price, who holds a role) used to come
// back from recall with confidence "strong" and nothing else. Now a row whose
// winning entry is past its shelf life since it was last verified moves,
// whole, to possibly_stale — the ranking untouched, what is current left
// where it was. Design: docs/design/staleness.md.
//
// Ageing goes through the file, as in the agentic benchmark: no CRBRO writes a
// past date. Recall reads verified, shelf_life and the dates from the neuron
// file it already loads for every row, so no reindex is needed for the
// partition to see an edit.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { entryId } from '../src/sync/ops.js';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const body = (r: any) => JSON.parse(r.content[0].text);

async function connect(root: string): Promise<Client> {
  process.env.CRBRO_PATH = root;
  const { createServer } = await import('../src/server.js');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer().connect(st);
  const client = new Client({ name: 'staleness-test', version: '1.0.0' });
  await client.connect(ct);
  return client;
}

/** Rewrite one neuron file in place, as the benchmark seeder does. */
async function edit(root: string, id: string, fn: (n: any) => void): Promise<void> {
  const file = path.join(root, 'cortex', `${id}.json`);
  const n = JSON.parse(await fs.readFile(file, 'utf8'));
  fn(n);
  await fs.writeFile(file, JSON.stringify(n, null, 2));
}

describe('staleness through the MCP tools', () => {
  let holder: string;
  let root: string;
  let client: Client;
  const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
  const json = async (name: string, args: Record<string, unknown> = {}) => body(await call(name, args));

  const PORT = 'El panel de administración de Pelícano escucha en el puerto 9090.';
  const PRICE = 'El plan Equipo de Pelícano cuesta 29 euros al mes.';
  const PLAIN = 'Pelícano es el servicio de facturación y se despliega con Docker Compose.';
  let pelicano: string;

  beforeAll(async () => {
    holder = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-stale-'));
    root = path.join(holder, 'brain');
    await fs.mkdir(root, { recursive: true });
    client = await connect(root);
    await call('crbro_boot');
    pelicano = (await json('crbro_learn', { topic: 'Pelícano', type: 'fact', content: PLAIN, keywords: ['facturas'] })).neuron_id;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    delete process.env.CRBRO_PATH;
    await fs.rm(holder, { recursive: true, force: true });
  });

  afterEach(() => { delete process.env.CRBRO_STALENESS; });

  it('learn returns the class that applies: inferred from the text, or the one given', async () => {
    const port = await json('crbro_learn', { topic: 'Pelícano', type: 'fact', content: PORT, keywords: ['admin'] });
    expect(port).toMatchObject({ shelf_life: 'volatile', shelf_inferred: true, shelf_reason: 'port' });

    const plain = await json('crbro_learn', { topic: 'Otro tema', type: 'fact', content: 'Las reuniones de equipo son los lunes.', keywords: ['meeting'] });
    expect(plain.shelf_life).toBe('normal');
    expect(plain.shelf_inferred).toBe(true);
    expect(plain.shelf_reason).toBeUndefined();

    const given = await json('crbro_learn', { topic: 'Pelícano', type: 'fact', content: PRICE, keywords: ['tarifa'], shelf_life: 'volatile' });
    expect(given.shelf_life).toBe('volatile');
    expect(given.shelf_inferred).toBeUndefined();
    const stored = JSON.parse(await fs.readFile(path.join(root, 'cortex', `${pelicano}.json`), 'utf8'));
    expect(stored.facts.find((f: any) => f.text === PRICE).shelf_life).toBe('volatile');
    // Nothing is stored that nobody decided: the inferred class lives nowhere.
    expect(stored.facts.find((f: any) => f.text === PORT).shelf_life).toBeUndefined();
    // A new fact has never been re-checked: no verified stamp.
    expect(stored.facts.find((f: any) => f.text === PORT).verified).toBeUndefined();
  });

  it('shelf_life is ignored for other kinds, with no error', async () => {
    const d = await json('crbro_learn', { topic: 'Pelícano', type: 'decision', content: 'Pelícano factura en euros.', shelf_life: 'volatile' });
    expect(d.action).toBe('updated');
    expect(d.shelf_life).toBeUndefined();
    const stored = JSON.parse(await fs.readFile(path.join(root, 'cortex', `${pelicano}.json`), 'utf8'));
    expect(stored.decisions[0].shelf_life).toBeUndefined();
  });

  it('recall moves an aged volatile row to possibly_stale and leaves what is current where it was', async () => {
    await edit(root, pelicano, n => { for (const f of n.facts) if (f.text === PORT) f.added = ago(200); });
    const port = await json('crbro_recall', { query: 'puerto panel administración Pelícano' });
    expect(port.results.map((r: any) => r.matching_content)).not.toContain(PORT);
    expect(port.possibly_stale).toHaveLength(1);
    const row = port.possibly_stale[0];
    expect(row).toMatchObject({ neuron_id: pelicano, last_known: PORT, age_days: 200, shelf_life: 'volatile', shelf_inferred: true });
    // Iteration 2: the old line is not served as ordinary content.
    expect(row.matching_content).toBeUndefined();
    expect(row.last_verified).toBe(ago(200).slice(0, 10));
    expect(row.entry_id).toBeTruthy();
    expect(row.staleness).toBeUndefined();                 // the internal field never leaves the server
    expect(port.possibly_stale_count).toBe(1);
    expect(port.total_results).toBe(0);
    expect(port.returned).toBe(1);
    expect(port.hint).toMatch(/^Nothing current matched/);
    expect(port.hint).toContain('crbro_revise neuron=<neuron_id> status=verified facts=[entry_id]');
    expect(port.hint).toContain('supersedes=[entry_id]');

    // The fresh line answers as before, with no new field at all.
    const fresh = await json('crbro_recall', { query: 'Docker Compose facturación' });
    expect(fresh.results[0].matching_content).toBe(PLAIN);
    expect(fresh.possibly_stale).toBeUndefined();
    expect(fresh.possibly_stale_count).toBeUndefined();
    expect(fresh.hint).not.toContain('possibly_stale');
    expect(fresh.results[0].staleness).toBeUndefined();
  });

  it('the partition runs after the ranking: rank order kept, no backfill, no re-heading', async () => {
    // Two neurons answer; the top one is stale. It moves, the second stays
    // second-ranked in results, and nothing lower is pulled in to fill.
    const otro = (await json('crbro_learn', { topic: 'Garza', type: 'fact', content: 'El panel de administración de Garza escucha en el puerto 7070.', keywords: ['admin'] })).neuron_id;
    const both = await json('crbro_recall', { query: 'panel administración puerto', limit: 2 });
    const all = [...both.results, ...(both.possibly_stale || [])].map((r: any) => r.neuron_id).sort();
    expect(all).toEqual([otro, pelicano].sort());
    expect(both.results.map((r: any) => r.neuron_id)).toEqual([otro]);
    expect(both.possibly_stale.map((r: any) => r.neuron_id)).toEqual([pelicano]);
    expect(both.returned).toBe(2);
    expect(both.hint).not.toMatch(/^Nothing current matched/);
    expect(both.hint).toContain('possibly_stale');
    // Never re-headed: the stale row still speaks with its stale line.
    expect(both.possibly_stale[0].last_known).toBe(PORT);
    // Every row keeps its rank, so results[0] is never mistaken for the best match.
    const ranks = [...both.results, ...both.possibly_stale].map((r: any) => r.rank).sort();
    expect(ranks).toEqual([1, 2]);
    if (both.possibly_stale[0].rank === 1) {
      expect(both.hint).toMatch(/^The best match \(rank 1\) moved to possibly_stale/);
    } else {
      expect(both.hint).not.toMatch(/^The best match/);
    }
  });

  it('when the top-ranked row moves, the hint says so first (review fix)', async () => {
    // A query only the stale Pelícano line answers well, plus a weaker row elsewhere.
    const r = await json('crbro_recall', { query: 'Pelícano panel administración puerto 9090', limit: 3 });
    expect(r.possibly_stale?.[0]).toMatchObject({ neuron_id: pelicano, rank: 1 });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.every((x: any) => x.rank > 1)).toBe(true);
    expect(r.hint).toMatch(/^The best match \(rank 1\) moved to possibly_stale; results holds lower-ranked rows/);
    // Without anything stale, rows carry no rank: the answer is as it always was.
    const fresh = await json('crbro_recall', { query: 'Docker Compose facturación' });
    expect(fresh.results[0].rank).toBeUndefined();
  });

  it('crbro_revise status=verified brings it back into results, and reading never does', async () => {
    const before = await json('crbro_recall', { query: 'puerto panel administración Pelícano' });
    const id = before.possibly_stale[0].entry_id;
    // Reading is not checking: inspect and recall leave verified alone.
    await call('crbro_inspect', { view: 'neuron', neuron: pelicano, entries: [id] });
    let stored = JSON.parse(await fs.readFile(path.join(root, 'cortex', `${pelicano}.json`), 'utf8'));
    expect(stored.facts.find((f: any) => f.text === PORT).verified).toBeUndefined();

    const v = await json('crbro_revise', { neuron: pelicano, status: 'verified', facts: [id], note: 'ignored' });
    expect(v.status).toBe('verified');
    expect(v.verified).toEqual([id]);
    expect(v.unmatched).toBeUndefined();
    stored = JSON.parse(await fs.readFile(path.join(root, 'cortex', `${pelicano}.json`), 'utf8'));
    const f = stored.facts.find((x: any) => x.text === PORT);
    expect(Date.now() - Date.parse(f.verified)).toBeLessThan(60_000);
    expect(f.revision_note).toBeUndefined();                // note is ignored for verified
    expect(f.status).toBe('active');

    const after = await json('crbro_recall', { query: 'puerto panel administración Pelícano' });
    expect(after.results.find((r: any) => r.neuron_id === pelicano).matching_content).toBe(PORT);
    expect(after.possibly_stale).toBeUndefined();
  });

  it('since keeps filtering on when a line was recorded, not on when it was checked', async () => {
    // The port line was recorded 200 days ago and verified just now. The
    // index carries the recorded date: rebuild it from the edited file first.
    await call('crbro_maintenance', {});
    const r = await json('crbro_recall', { query: 'puerto panel administración Pelícano', since: '30d' });
    const served = [...r.results, ...(r.possibly_stale || [])].map((x: any) => x.matching_content ?? x.last_known);
    expect(served).not.toContain(PORT);
  });

  it('learning the same text again reconfirms it (a session is a check)', async () => {
    await edit(root, pelicano, n => { for (const f of n.facts) if (f.text === PRICE) { f.added = ago(150); delete f.verified; } });
    const stale = await json('crbro_recall', { query: 'plan Equipo cuesta euros' });
    expect(stale.possibly_stale?.[0]?.last_known).toBe(PRICE);

    const again = await json('crbro_learn', { topic: 'Pelícano', type: 'fact', content: PRICE, keywords: ['tarifa'] });
    expect(again.reconfirmed).toBe(true);
    expect(again.shelf_life).toBe('volatile');
    const fresh = await json('crbro_recall', { query: 'plan Equipo cuesta euros' });
    expect(fresh.results[0].matching_content).toBe(PRICE);
    expect(fresh.possibly_stale).toBeUndefined();
  });

  it('a re-learn that only adds keywords is not a check: the line stays in possibly_stale (review fix)', async () => {
    await edit(root, pelicano, n => { for (const f of n.facts) if (f.text === PRICE) { f.added = ago(200); delete f.verified; } });
    const r = await json('crbro_learn', { topic: 'Pelícano', type: 'fact', content: PRICE, keywords: ['suscripción', 'cuota'] });
    expect(r.updated_in_place).toBe(true);
    expect(r.reconfirmed).toBeUndefined();
    const still = await json('crbro_recall', { query: 'plan Equipo cuesta euros' });
    expect(still.possibly_stale?.[0]?.last_known).toBe(PRICE);
    // The bare repeat is the check.
    const bare = await json('crbro_learn', { topic: 'Pelícano', type: 'fact', content: PRICE });
    expect(bare.reconfirmed).toBe(true);
    const fresh = await json('crbro_recall', { query: 'plan Equipo cuesta euros' });
    expect(fresh.results[0].matching_content).toBe(PRICE);
  });

  it('a different shelf_life on the same text replaces the stored one (updated_in_place)', async () => {
    const r = await json('crbro_learn', { topic: 'Pelícano', type: 'fact', content: PRICE, keywords: ['tarifa'], shelf_life: 'durable' });
    expect(r.updated_in_place).toBe(true);
    expect(r.shelf_life).toBe('durable');
    const stored = JSON.parse(await fs.readFile(path.join(root, 'cortex', `${pelicano}.json`), 'utf8'));
    expect(stored.facts.find((f: any) => f.text === PRICE).shelf_life).toBe('durable');
  });

  it('revise status=verified: decisions and patterns by text or id, retired targets refused with the reason', async () => {
    const pattern = 'Para desplegar Pelícano: docker compose pull y luego up -d.';
    await call('crbro_learn', { topic: 'Pelícano', type: 'pattern', content: pattern });
    const retiredText = 'Pelícano usaba MySQL 5.7 al principio.';
    await call('crbro_learn', { topic: 'Pelícano', type: 'fact', content: retiredText, keywords: ['legacy'] });
    await call('crbro_revise', { neuron: pelicano, facts: [retiredText], status: 'superseded' });

    const r = await json('crbro_revise', {
      neuron: pelicano, status: 'verified',
      entries: ['Pelícano factura en euros.', entryId(pattern), 'una entrada que no existe'],
      facts: [retiredText],
    });
    expect(r.verified).toEqual(expect.arrayContaining([entryId('Pelícano factura en euros.'), entryId(pattern)]));
    expect(r.unmatched).toEqual(expect.arrayContaining(['una entrada que no existe', retiredText]));
    expect(r.retired_targets).toEqual([expect.objectContaining({ target: retiredText, status: 'superseded' })]);
    expect(r.message).toMatch(/reactivate it with status active first/);
    const stored = JSON.parse(await fs.readFile(path.join(root, 'cortex', `${pelicano}.json`), 'utf8'));
    expect(Object.keys(stored.entry_verified).sort()).toEqual([entryId('Pelícano factura en euros.'), entryId(pattern)].sort());
    // A retired fact is not stamped.
    expect(stored.facts.find((f: any) => f.text === retiredText).verified).toBeUndefined();
  });

  it('inspect shows verified, an explicit shelf_life and stale_days; status reports the feature', async () => {
    await edit(root, pelicano, n => { for (const f of n.facts) if (f.text === PORT) { f.added = ago(300); f.verified = ago(120); } });
    const idx = await json('crbro_inspect', { view: 'neuron', neuron: pelicano, limit: 50 });
    const port = idx.entries.find((e: any) => e.preview === PORT);
    expect(port).toMatchObject({ verified: ago(120).slice(0, 10), stale_days: 120 });
    expect(port.shelf_life).toBeUndefined();              // inferred classes are not stored, so not shown as set
    const price = idx.entries.find((e: any) => e.preview === PRICE);
    expect(price.shelf_life).toBe('durable');
    expect(price.stale_days).toBeUndefined();
    const plain = idx.entries.find((e: any) => e.preview === PLAIN);
    expect(plain.stale_days).toBeUndefined();

    const full = await json('crbro_inspect', { view: 'neuron', neuron: pelicano, entries: [port.id] });
    expect(full.entries[0]).toMatchObject({ text: PORT, stale_days: 120 });
    expect(String(full.entries[0].verified).slice(0, 10)).toBe(ago(120).slice(0, 10));

    const status: any = await call('crbro_inspect', { view: 'status' });
    expect(status.structuredContent.status.staleness).toMatchObject({ enabled: true, windows: { volatile: 90, normal: 365, durable: 730 } });
    expect(status.structuredContent.status.staleness.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('also_matched lines past their shelf life carry stale_days and keep their place', async () => {
    const extra = 'El panel de Pelícano usa el puerto 9091 para métricas internas.';
    await call('crbro_learn', { topic: 'Pelícano', type: 'fact', content: extra, keywords: ['metrics'] });
    await edit(root, pelicano, n => {
      for (const f of n.facts) {
        if (f.text === extra) f.added = ago(400);
        if (f.text === PORT) { f.added = ago(1); delete f.verified; }
      }
    });
    // "administración" is only in PORT: it wins, current, and the old line
    // rides along as a preview.
    const r = await json('crbro_recall', { query: 'panel administración Pelícano puerto' });
    const row = r.results.find((x: any) => x.neuron_id === pelicano);
    expect(row.matching_content).toBe(PORT);
    const line = (row.also_matched || []).find((x: any) => x.preview === extra);
    expect(line).toMatchObject({ stale_days: 400, kind: 'fact' });
    // A fresh preview carries no such field.
    for (const a of row.also_matched || []) if (a.preview !== extra && a.preview !== PRICE) expect(a.stale_days).toBeUndefined();
  });

  it('maintenance reports stale_entries and the most overdue, read-only', async () => {
    const file = path.join(root, 'cortex', `${pelicano}.json`);
    const before = await fs.readFile(file, 'utf8');
    const r = await json('crbro_maintenance', { dry_run: true });
    expect(r.stale_entries).toBeGreaterThanOrEqual(1);
    const top = r.stale_sample[0];
    expect(top).toMatchObject({ neuron_id: pelicano, kind: 'fact', shelf_life: 'volatile', inferred: true });
    expect(top.age_days).toBeGreaterThan(90);
    expect(r.notes.join(' ')).toMatch(/possibly_stale/);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it('CRBRO_STALENESS=0: recall answers exactly as before, with no new field', async () => {
    process.env.CRBRO_STALENESS = '0';
    const r = await json('crbro_recall', { query: 'panel Pelícano puerto métricas' });
    expect(r.possibly_stale).toBeUndefined();
    expect(JSON.stringify(r)).not.toMatch(/stale_days|age_days|shelf_life|staleness/);
    expect(r.results.length).toBeGreaterThan(0);
    const m = await json('crbro_maintenance', { dry_run: true });
    expect(m.stale_entries).toBeUndefined();
  });
});

describe('a shared neuron: lengthening a shelf life is local only, and learn says so', () => {
  let holder: string;
  let root: string;
  let client: Client;
  const json = async (name: string, args: Record<string, unknown> = {}) => body(await client.callTool({ name, arguments: args }));

  beforeAll(async () => {
    holder = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-stale-shared-'));
    root = path.join(holder, 'brain');
    await fs.mkdir(root, { recursive: true });
    client = await connect(root);
    await json('crbro_boot');
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    delete process.env.CRBRO_PATH;
    await fs.rm(holder, { recursive: true, force: true });
  });

  it('shared_warning on a longer class for a shared neuron; nothing when shorter or not shared', async () => {
    const TXT = 'El plan Básico de Martín cuesta 9 euros al mes.';
    const id = (await json('crbro_learn', { topic: 'Martín', type: 'fact', content: TXT, keywords: ['precio'], shelf_life: 'volatile' })).neuron_id;
    // Not shared yet: lengthening is simply applied.
    const local = await json('crbro_learn', { topic: 'Martín', type: 'fact', content: TXT, shelf_life: 'normal' });
    expect(local.shared_warning).toBeUndefined();
    await json('crbro_learn', { topic: 'Martín', type: 'fact', content: TXT, shelf_life: 'volatile' });
    // Marked shared (the map file is what sharedMap reads).
    await fs.writeFile(path.join(root, 'shared-map.json'), JSON.stringify({ [id]: 'equipo' }));
    const longer = await json('crbro_learn', { topic: 'Martín', type: 'fact', content: TXT, shelf_life: 'durable' });
    expect(longer.shared_warning).toMatch(/shared in space "equipo".*local only.*restores the more volatile value/);
    const shorter = await json('crbro_learn', { topic: 'Martín', type: 'fact', content: TXT, shelf_life: 'volatile' });
    expect(shorter.shared_warning).toBeUndefined();
  });
});

describe('a brain written before shelf life', () => {
  let holder: string;
  let root: string;
  let client: Client;
  const json = async (name: string, args: Record<string, unknown> = {}) => body(await client.callTool({ name, arguments: args }));

  const OLD_PLAIN = 'Los informes mensuales se envían al cliente por correo.';
  const OLD_PORT = 'La API interna de Garza escucha en el puerto 8080.';
  const UNDATED = 'El servidor de Garza está en el puerto 2222.';

  beforeAll(async () => {
    holder = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-stale-legacy-'));
    root = path.join(holder, 'brain');
    // The shape 2.8 wrote: no staleness_since, no verified, no shelf_life,
    // no entry_verified — and dates far in the past.
    await fs.mkdir(path.join(root, 'cortex'), { recursive: true });
    for (const d of ['synapses', 'hippocampus', 'prefrontal', 'archives', '.quarantine']) await fs.mkdir(path.join(root, d), { recursive: true });
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
      version: '1.0.0', created: ago(900), owner: 'user', brain_path: root,
      total_neurons: 1, total_synapses: 0, total_sessions: 0, last_boot: ago(10), last_consolidation: null,
    }));
    await fs.writeFile(path.join(root, 'cortex', 'project_garza.json'), JSON.stringify({
      id: 'project_garza', name: 'Garza', domain: 'general', type: 'project',
      created: ago(900), last_accessed: ago(10), access_count: 3, heat: 0.5, summary: '',
      facts: [
        { text: OLD_PLAIN, confidence: 1, added: ago(800), source: 'session', id: 'f_plain', status: 'active' },
        { text: OLD_PORT, confidence: 1, added: ago(400), source: 'session', id: 'f_port', status: 'active' },
        { text: UNDATED, confidence: 1, added: '', source: 'session', id: 'f_undated', status: 'active' },
      ],
      decisions: [{ text: 'Garza se despliega a mano.', date: ago(900), rationale: '' }],
      patterns: [], preferences: [], connections: [], tags: [], errors: [], debts: [], entry_dates: {},
    }, null, 2));
    client = await connect(root);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    delete process.env.CRBRO_PATH;
    await fs.rm(holder, { recursive: true, force: true });
  });

  it('boot stamps staleness_since once, in the manifest only, and touches no neuron', async () => {
    const file = path.join(root, 'cortex', 'project_garza.json');
    const before = await fs.readFile(file, 'utf8');
    await json('crbro_boot');
    const m1 = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
    expect(Date.now() - Date.parse(m1.staleness_since)).toBeLessThan(60_000);
    await json('crbro_boot');
    const m2 = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
    expect(m2.staleness_since).toBe(m1.staleness_since);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it('old non-volatile lines get the grace; an old volatile one is flagged; an undated one never is', async () => {
    const plain = await json('crbro_recall', { query: 'informes mensuales cliente correo' });
    expect(plain.results[0].matching_content).toBe(OLD_PLAIN);
    expect(plain.possibly_stale).toBeUndefined();

    const decision = await json('crbro_recall', { query: 'Garza despliega mano' });
    expect(decision.results[0].matching_content).toContain('Garza se despliega a mano.');

    const port = await json('crbro_recall', { query: 'API interna Garza puerto' });
    expect(port.possibly_stale?.[0]).toMatchObject({ last_known: OLD_PORT, age_days: 400, shelf_life: 'volatile' });

    const undated = await json('crbro_recall', { query: 'servidor Garza puerto 2222' });
    const row = [...undated.results, ...(undated.possibly_stale || [])].find((r: any) => (r.matching_content ?? r.last_known) === UNDATED);
    expect(row).toBeTruthy();
    expect(undated.results.map((r: any) => r.matching_content)).toContain(UNDATED);
  });

  it('a manifest write from a cache older than the stamp keeps the stamp (review fix)', async () => {
    const { Brain } = await import('../src/engine/brain.js');
    const mf = path.join(root, 'manifest.json');
    const sello = JSON.parse(await fs.readFile(mf, 'utf8')).staleness_since;
    expect(sello).toBeTruthy();
    // A process that cached the manifest before the first boot of this version.
    const viejo = new Brain(root);
    const cache = JSON.parse(await fs.readFile(mf, 'utf8'));
    delete cache.staleness_since;
    (viejo as any).manifest = cache;
    await viejo.updateManifest({ total_sessions: 7 });
    const m = JSON.parse(await fs.readFile(mf, 'utf8'));
    expect(m.total_sessions).toBe(7);
    expect(m.staleness_since).toBe(sello);
    // And a writer that dropped it (an older CRBRO) is undone by the next boot of a process that knew it.
    await fs.writeFile(mf, JSON.stringify({ ...m, staleness_since: undefined }));
    await viejo.boot();
    expect(JSON.parse(await fs.readFile(mf, 'utf8')).staleness_since).toBe(sello);
  });

  it('recall writes nothing to the neuron file', async () => {
    const file = path.join(root, 'cortex', 'project_garza.json');
    const before = await fs.readFile(file, 'utf8');
    await json('crbro_recall', { query: 'API interna Garza puerto' });
    await json('crbro_inspect', { view: 'neuron', neuron: 'project_garza' });
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });
});
