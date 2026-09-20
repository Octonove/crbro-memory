// ─── Dating what was written before dates existed (2.5) ──────────
//
// 249 of 457 patterns, preferences, errors and debts on the reference brain
// had no date, because the sidecar only exists since 1.13. 130 of them say
// when they happened in their own words. The rule these tests pin: a date is
// recovered from the entry's text or not at all. The neuron's `created` was
// measured as a fallback and rejected — a 117-day window is not a date.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { datesInText, inferEntryDay, isDayPrecision } from '../src/engine/dates.js';
import { entryId } from '../src/sync/ops.js';

describe('datesInText', () => {
  const days = (t: string) => datesInText(t).map(d => d.day);

  it('reads the shapes people actually write', () => {
    expect(days('Hallazgo (2026-08-30): las tareas fallaban.')).toEqual(['2026-08-30']);
    expect(days('El 14-sep-2026 se enviaron 27 emails.')).toEqual(['2026-09-14']);
    expect(days('Decidido el 3 de agosto de 2026 por la tarde.')).toEqual(['2026-08-03']);
    expect(days('Shipped on August 30, 2026 after review.')).toEqual(['2026-08-30']);
    expect(days('Visto el 30/08/2026 y otra vez el 31.08.2026.')).toEqual(['2026-08-30', '2026-08-31']);
    expect(days('Le 2 février 2026, am 5. März 2026, il 7 luglio 2026.')).toEqual(['2026-02-02', '2026-03-05', '2026-07-07']);
  });

  it('refuses what is not a calendar day', () => {
    expect(days('versión 2026-13-40 y el 31-02-2026')).toEqual([]);
    expect(days('3 cartas 2026, 12 out 2026 of range')).toEqual([]);
    expect(days('en agosto, el 24-ago, 14/09/26')).toEqual([]);
  });

  it('keeps both readings of a numeric date that allows two', () => {
    expect(datesInText('el 04/09/2026')).toEqual([{ day: '2026-09-04', alt: '2026-04-09' }]);
    expect(datesInText('el 09/09/2026')).toEqual([{ day: '2026-09-09' }]);
    expect(datesInText('on 08/30/2026')).toEqual([{ day: '2026-08-30' }]);
  });
});

describe('inferEntryDay', () => {
  it('takes the latest date inside the window: an entry cannot predate what it mentions', () => {
    expect(inferEntryDay('Roto el 2026-08-18, arreglado el 2026-08-20.', '2026-05-01', '2026-09-03')).toBe('2026-08-20');
  });

  it('ignores a deadline after the ceiling and history before the neuron existed', () => {
    const t = 'Desde 2025-01-10 pasaba; visto el 2026-08-25; REVISAR CUANDO: 2026-10-04.';
    expect(inferEntryDay(t, '2026-05-01T09:00:00.000Z', '2026-09-03T18:00:00.000Z')).toBe('2026-08-25');
  });

  it('lets the window settle an ambiguous numeric date, and gives up when it cannot', () => {
    expect(inferEntryDay('el 04/09/2026', '2026-08-01', '2026-09-30')).toBe('2026-09-04');
    expect(inferEntryDay('on 04/09/2026', '2026-03-01', '2026-05-01')).toBe('2026-04-09');
    expect(inferEntryDay('el 04/09/2026', '2026-01-01', '2026-12-31')).toBe('');
  });

  it('proves nothing from a text with no date', () => {
    expect(inferEntryDay('Todos los sitios usan el mismo workflow.', '2026-05-01', '2026-09-03')).toBe('');
  });
});

describe('crbro_maintenance backfill_dates', () => {
  let holder: string;
  let root: string;
  let client: Client;
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }) as Promise<any>;
  const body = (r: any) => JSON.parse(r.content[0].text);

  // The window is [created, first stamp on the brain], and in a test the first
  // stamp is today — so the stated date has to sit between the two.
  const DATED = 'CAUSA RAÍZ encontrada (2026-08-25): el cron publicaba con la zona horaria del servidor.';
  const UNDATED = 'Todos los sitios del portfolio usan el mismo workflow programático.';
  const FRESH = 'Patrón nuevo, aprendido hoy mismo con su sello.';
  let file: string;

  // One brain for the four steps, in order: the server binds its path once.
  beforeAll(async () => {
    holder = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-backfill-'));
    root = path.join(holder, 'brain');
    await fs.mkdir(root, { recursive: true });
    process.env.CRBRO_PATH = root;
    const { createServer } = await import('../src/server.js');
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer().connect(st);
    client = new Client({ name: 'backfill-test', version: '1.0.0' });
    await client.connect(ct);
    await call('crbro_boot');

    // A neuron as 1.12 left it: entries present, no stamp for them.
    const r = body(await call('crbro_learn', { topic: 'Publicación diaria', type: 'pattern', content: DATED }));
    await call('crbro_learn', { neuron_id: r.neuron_id, type: 'error', content: UNDATED });
    await call('crbro_learn', { neuron_id: r.neuron_id, type: 'pattern', content: FRESH });
    file = path.join(root, 'cortex', `${r.neuron_id}.json`);
    const n = JSON.parse(await fs.readFile(file, 'utf8'));
    n.created = '2026-05-08T10:00:00.000Z';
    delete n.entry_dates[entryId(DATED)];
    delete n.entry_dates[entryId(UNDATED)];
    await fs.writeFile(file, JSON.stringify(n, null, 2));
  });

  afterAll(async () => {
    await client?.close();
    delete process.env.CRBRO_PATH;
    await fs.rm(holder, { recursive: true, force: true });
  });

  const dates = async () => JSON.parse(await fs.readFile(file, 'utf8')).entry_dates as Record<string, string>;

  it('a plain run counts and writes nothing', async () => {
    const r = body(await call('crbro_maintenance', {}));
    expect(r).toMatchObject({ undated_entries: 2, datable_entries: 1, dates_backfilled: 0 });
    expect(r.notes.join(' ')).toMatch(/backfill_dates:true/);
    expect((await dates())[entryId(DATED)]).toBeUndefined();
  });

  it('a dry run with the flag still writes nothing', async () => {
    const r = body(await call('crbro_maintenance', { dry_run: true, backfill_dates: true }));
    expect(r).toMatchObject({ undated_entries: 2, datable_entries: 1, dates_backfilled: 0 });
    expect((await dates())[entryId(DATED)]).toBeUndefined();
  });

  it('dates what the text proves, to the day, and leaves the rest alone', async () => {
    const stamp = (await dates())[entryId(FRESH)];
    const r = body(await call('crbro_maintenance', { backfill_dates: true }));
    expect(r).toMatchObject({ undated_entries: 2, datable_entries: 1, dates_backfilled: 1 });
    const d = await dates();
    expect(d[entryId(DATED)]).toBe('2026-08-25');
    expect(isDayPrecision(d[entryId(DATED)])).toBe(true);
    expect(d[entryId(UNDATED)]).toBeUndefined();
    expect(d[entryId(FRESH)]).toBe(stamp);              // a real stamp is never rewritten
    expect(isDayPrecision(stamp)).toBe(false);
  });

  it('recall shows the recovered date, and a second run finds nothing left to do', async () => {
    const hit = body(await call('crbro_recall', { query: 'cron zona horaria del servidor' })).results[0];
    expect(hit.matched_kind).toBe('pattern');
    expect(hit.matched_added).toBe('2026-08-25');
    const again = body(await call('crbro_maintenance', { backfill_dates: true }));
    expect(again).toMatchObject({ undated_entries: 1, datable_entries: 0, dates_backfilled: 0 });
  });
});
