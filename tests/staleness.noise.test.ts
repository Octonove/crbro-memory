// ─── Shelf life 2.9.1: less noise, the same warnings that matter ─
//
// Run over a real personal brain, 2.9.0 flagged about a sixth of the active
// entries on the first day, all of them inferred volatile and none graced.
// Most were not values that may have changed: lines the miner imported, and
// dated records of something done ("FASE 2 completada (ago 2026)"). This file
// pins the four fixes of 2.9.1 (docs/design/staleness.md §15):
//   1. a miner line never warns (permanent, reason "miner");
//   2. a dated record of something done is history (permanent, "history"),
//      and a dated statement of STATE is not;
//   3. in a brain that predates shelf life, inferred-volatile facts get the
//      staggered grace too; marked-by-hand volatile ones still do not;
//   4. view=status says the version the process runs, and apart the one on
//      disk when they differ.
// Every subject and value below is invented for this file.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  detectShelf, isDatedRecord, shelfOfFact, factStaleness, stalenessContext, stalenessContextOf, isLegacyBrain,
  spreadOf, DEFAULT_SHELF_DAYS, type StalenessContext,
} from '../src/engine/shelf.js';
import { entryId } from '../src/sync/ops.js';
import { readPackageVersion, versionStatus, RUNNING_VERSION, PACKAGE_JSON } from '../src/version.js';
import type { Fact } from '../src/types/index.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const ago = (days: number, now = NOW) => new Date(now - days * DAY).toISOString();
const fact = (text: string, extra: Partial<Fact> = {}): Fact => ({ text, confidence: 1, added: ago(0), source: 'session', status: 'active', ...extra });
const ctxOf = (extra: Partial<StalenessContext> = {}): StalenessContext => ({ nowMs: NOW, windows: { ...DEFAULT_SHELF_DAYS }, ...extra });

// ─── 1. The miner ────────────────────────────────────────────────

describe('a line the miner imported never warns', () => {
  const MINED = '- x Navigate to https://panel.ejemplo-garza.dev/ajustes (or refresh if already open).';

  it('is permanent, inferred, with reason "miner" — whatever its text says', () => {
    expect(shelfOfFact(fact(MINED, { source: 'miner' }))).toEqual({ shelf: 'permanent', inferred: true, reason: 'miner' });
    expect(shelfOfFact(fact('El panel escucha en el puerto 9090.', { source: 'miner' }))).toMatchObject({ shelf: 'permanent', reason: 'miner' });
  });

  it('is never stale, however old, and says why', () => {
    const s = factStaleness(fact(MINED, { source: 'miner', added: ago(900) }), ctxOf({ since: ago(400) }))!;
    expect(s).toMatchObject({ stale: false, shelf_life: 'permanent', shelf_inferred: true, shelf_reason: 'miner', window: null });
  });

  it('the same text from a session is still judged by its content', () => {
    expect(shelfOfFact(fact(MINED))).toEqual({ shelf: 'volatile', inferred: true, reason: 'url' });
    expect(factStaleness(fact(MINED, { added: ago(200) }), ctxOf({ since: ago(100) }))!.stale).toBe(true);
  });

  it('an explicit shelf_life still wins over the source', () => {
    expect(shelfOfFact(fact(MINED, { source: 'miner', shelf_life: 'volatile' }))).toEqual({ shelf: 'volatile', inferred: false });
    expect(factStaleness(fact(MINED, { source: 'miner', shelf_life: 'volatile', added: ago(200) }), ctxOf({ since: ago(100) }))!.stale).toBe(true);
  });
});

// ─── 2. History: a dated record of something done ────────────────

describe('a dated record of something done is history', () => {
  // The shapes the 2.9.0 report found, with invented subjects.
  const records = [
    'FIX del formulario de alta de Garza (3-ago-2026): el campo de teléfono no validaba.',
    'FASE 2 de Garza completada (ago 2026). Backend con 6 funciones en https://api.ejemplo-garza.dev.',
    '2026-08-11: VERIFICADO que la copia nocturna de garza-prod restaura sin errores en /srv/garza.',
    'Auditoría completa 21/07/2026 del sitio garza.example.com: 41 hallazgos.',
    'RECHAZO de la tienda de extensiones a Garza v3.4.0 (9 jul 2026): permisos no justificados.',
    'Plantillas de Garza PUBLICADAS en el repositorio (2026-07-30), con release v0.9.0.',
    '12-ago-2026: RENOMBRADO aplicado en ~/plantillas/garza.',
    'Migrado el servidor de Garza a PostgreSQL 16 el 3 de octubre de 2026.',
    'Deployed v2.3.1 of the Garza API to production on 2026-06-18.',
    'Released Garza CLI 1.4.0 on June 17, 2026.',
    'Hotfix 05/08/2026: el puerto 8443 vuelve a responder.',
    'Bug del calendario en Safari corregido (6-ago-2026), con la cabecera en garza.example.com.',
    'Repaso del blog de Garza COMPLETADO (2026-07-19): 23 posts, 4 de precios a 29 €.',
    'Ejecución de la tarea programada garza-boletin el 2026-09-02: no se envió nada desde garza.example.com.',
    'El 9 de septiembre de 2026 se publicó en garza.example.com la entrada 418.',
    'Checked on 2-sep-2026 in the Garza logs: the worker on port 8443 answered.',
  ];
  for (const text of records) {
    it(`history: ${text}`, () => {
      expect(isDatedRecord(text)).toBe(true);
      expect(detectShelf(text)).toEqual({ shelf: 'permanent', reason: 'history' });
    });
  }

  it('history never goes stale, and an explicit class still wins', () => {
    const text = 'RECHAZO de la tienda de extensiones a Garza v3.4.0 (9 jul 2026): permisos no justificados.';
    expect(factStaleness(fact(text, { added: ago(500) }), ctxOf({ since: ago(400) }))).toMatchObject({ stale: false, shelf_life: 'permanent', shelf_reason: 'history' });
    expect(factStaleness(fact(text, { added: ago(500), shelf_life: 'volatile' }), ctxOf({ since: ago(400) }))!.stale).toBe(true);
  });
});

describe('a dated statement of state is not history', () => {
  // Each one carries a date and a changeable value: it must keep warning.
  const state: Array<[string, string]> = [
    ['Desde el 18-sep el panel de Garza escucha en el puerto 9443.', 'port'],
    ['A 4-oct el precio del plan Equipo de Garza es 35 €.', 'price'],
    ['Comprobado a 4-oct-2026: el plan Equipo de Garza cuesta 35 €.', 'price'],
    ['Servidor de Garza migrado; desde el 18-sep-2026 el puerto es 9443.', 'port'],
    ['A partir del 1-oct-2026 la API de Garza vive en api2.ejemplo-garza.dev.', 'host'],
    ['Since 2026-09-18 the Garza admin listens on port 9443 (migrated).', 'port'],
    ['As of 2026-10-01 the Garza Pro plan is $49 per month, confirmed by sales.', 'price'],
    ['La API de Garza corre en el puerto 8443, desplegada el 2026-06-18.', 'port'],
    ['Garza usa Node 22, migrado el 3-oct-2026.', 'version'],
    ['Dominio garza.example.com renovado el 2026-01-03; caduca el 2027-01-03.', 'host'],
    ['Garza 3.0.0 will be released on 2026-11-01.', 'version'],
    ['Último despliegue de Garza: v2.2.0, publicado el 2026-06-18.', 'version'],
    ['Last deployed 2026-06-18: Garza v2.2.0 on garza.example.com.', 'version'],
    ['Actualmente Garza corre en localhost:5833, instalado el 2026-06-01.', 'port'],
    ['Precio de Garza actualizado el 4-oct-2026: 35 € al mes.', 'price'],
    ['Cambiado el 18-sep-2026: el panel de Garza usa el puerto 9443.', 'port'],
    ['El despliegue de Garza debe estar terminado para el 2026-11-15 en garza.example.com.', 'host'],
    ['Reel de Garza creado y programado en Buffer para el 5-oct-2026 en garza.example.com.', 'host'],
    ['Plan Pro de Garza confirmado el 2026-09-01, pendiente de pagar 49 € al mes.', 'price'],
  ];
  for (const [text, reason] of state) {
    it(`still volatile (${reason}): ${text}`, () => {
      expect(isDatedRecord(text)).toBe(false);
      expect(detectShelf(text)).toEqual({ shelf: 'volatile', reason });
    });
  }

  // State without a date: unchanged from 2.9.0.
  const undated: Array<[string, string]> = [
    ['DiarioGarza corre en localhost:5833.', 'port'],
    ['Garza requiere el plan Empresa de $299/año.', 'price'],
    ['El panel de Garza necesita la extensión v4.1.0 o superior.', 'version'],
    ['Publicado el artículo de Garza en https://blog.ejemplo-garza.dev/precios/.', 'url'],
  ];
  for (const [text, reason] of undated) {
    it(`no date, no history (${reason}): ${text}`, () => {
      expect(detectShelf(text)).toEqual({ shelf: 'volatile', reason });
    });
  }

  it('paths and branch names are not events: "fix-newsletter/", "hotfix/login"', () => {
    expect(isDatedRecord('Informes en fix-newsletter/seo-reports/ desde 2026-06-22.')).toBe(false);
    expect(isDatedRecord('La rama hotfix/login (2026-06-16) sigue abierta en el repo.')).toBe(false);
  });

  it('a version that looks like a date is not one: "1.4.22"', () => {
    expect(isDatedRecord('Fixed in 1.4.22 of the Garza plugin.')).toBe(false);
  });

  it('only the head decides: details after the first sentence are not judged', () => {
    // Documented limit: the record's own date tells the reader how old the host is.
    expect(isDatedRecord('Migrado Garza a otro proveedor (3-oct-2026). Ahora el host es 10.0.0.5.')).toBe(true);
    // A head that is not a record is not rescued by a later sentence.
    expect(isDatedRecord('Garza escucha en el puerto 9443. Migrado el 3-oct-2026.')).toBe(false);
  });
});

// ─── 3. The grace for legacy brains ──────────────────────────────

describe('inferred-volatile facts get the grace in a brain that predates shelf life', () => {
  const PORT = 'El panel de Garza escucha en el puerto 9090.';
  const STAMP = ago(0);                 // first boot of 2.9.x: today
  const OLD_BRAIN = ago(500);           // created long before
  const legacy = () => stalenessContext(STAMP, {}, NOW, OLD_BRAIN)!;
  const born = () => stalenessContext(STAMP, {}, NOW, STAMP)!;

  it('a legacy brain is one created well before its stamp, or not stamped yet', () => {
    expect(isLegacyBrain(OLD_BRAIN, STAMP)).toBe(true);
    expect(isLegacyBrain(STAMP, STAMP)).toBe(false);
    expect(isLegacyBrain(ago(0.0001), STAMP)).toBe(false);   // initialize(): the same call, milliseconds apart
    expect(isLegacyBrain(OLD_BRAIN, undefined)).toBe(true);  // not stamped yet
    expect(isLegacyBrain(null, STAMP)).toBe(true);           // creation date unreadable
    expect(legacy().legacy).toBe(true);
    expect(born().legacy).toBeUndefined();
    // No creation date passed: the 2.9.0 behaviour.
    expect(stalenessContext(STAMP, {}, NOW).legacy).toBeUndefined();
    expect(stalenessContextOf({ staleness_since: STAMP, created: OLD_BRAIN }, {}, NOW)!.legacy).toBe(true);
    expect(stalenessContextOf({ staleness_since: STAMP, created: STAMP }, {}, NOW)!.legacy).toBeUndefined();
    expect(stalenessContextOf(undefined, {}, NOW)!.legacy).toBeUndefined();
  });

  it('on upgrade day an old inferred-volatile line is not stale; it counts from near the stamp', () => {
    const s = factStaleness(fact(PORT, { added: ago(400) }), legacy())!;
    const back = (90 / 2) * spreadOf(entryId(PORT));
    expect(s).toMatchObject({ stale: false, shelf_life: 'volatile', shelf_inferred: true, shelf_reason: 'port', age_days: Math.floor(back) });
    expect(s.age_from).toBe(ago(back).slice(0, 10));
    expect(s.last_verified).toBe(ago(400).slice(0, 10));
  });

  it('it still comes due within the first volatile window after the stamp, staggered', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `El servicio ${i} de Garza escucha en el puerto ${9000 + i}.`);
    const due = lines.map(t => {
      for (let d = 0; d <= 120; d++) {
        const now = NOW + d * DAY;
        if (factStaleness(fact(t, { added: ago(400) }), stalenessContext(STAMP, {}, now, OLD_BRAIN)!)!.stale) return d;
      }
      return -1;
    });
    expect(Math.min(...due)).toBeGreaterThanOrEqual(46);   // nothing before half a window
    expect(Math.max(...due)).toBeLessThanOrEqual(91);      // everything within one window
    expect(new Set(due).size).toBeGreaterThan(15);         // not one avalanche
  });

  it('a line written after the stamp gets no grace, legacy brain or not', () => {
    const s = factStaleness(fact(PORT, { added: ago(100) }), stalenessContext(ago(200), {}, NOW, OLD_BRAIN)!)!;
    expect(s).toMatchObject({ stale: true, age_days: 100 });
    expect(s.age_from).toBeUndefined();
  });

  it('marked volatile by hand: no grace, as in 2.9.0', () => {
    const s = factStaleness(fact('Una clave que rota cada trimestre.', { added: ago(400), shelf_life: 'volatile' }), legacy())!;
    expect(s).toMatchObject({ stale: true, age_days: 400, shelf_inferred: false });
    expect(s.age_from).toBeUndefined();
  });

  it('a brain born with shelf life flags an old inferred-volatile line at once (seeded, synced, imported)', () => {
    const s = factStaleness(fact(PORT, { added: ago(400) }), born())!;
    expect(s).toMatchObject({ stale: true, age_days: 400 });
    expect(s.age_from).toBeUndefined();
  });

  it('a verified line gets no grace either way', () => {
    const s = factStaleness(fact(PORT, { added: ago(400), verified: ago(120) }), legacy())!;
    expect(s).toMatchObject({ stale: true, age_days: 120 });
  });
});

// ─── 4. The version status reports ───────────────────────────────

describe('the version view=status reports', () => {
  it('the running version is the package.json read at load', async () => {
    const pkg = JSON.parse(await fs.readFile(PACKAGE_JSON, 'utf8'));
    expect(RUNNING_VERSION).toBe(pkg.version);
    expect(readPackageVersion()).toBe(pkg.version);
  });

  it('same version on disk: the running one alone, no note', () => {
    expect(versionStatus('2.9.1', '2.9.1')).toEqual({ crbro_version: '2.9.1' });
  });

  it('another version on disk: the running one, and the disk one apart with a note to restart', () => {
    const v = versionStatus('2.9.0', '2.9.1');
    expect(v.crbro_version).toBe('2.9.0');
    expect(v.installed_version).toBe('2.9.1');
    expect(v.version_note).toMatch(/2\.9\.1 is installed but this process still runs 2\.9\.0: restart the client/);
  });

  it('a disk it cannot read changes nothing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-version-'));
    try {
      expect(readPackageVersion(path.join(dir, 'missing.json'))).toBe('unknown');
      await fs.writeFile(path.join(dir, 'package.json'), '{ not json');
      expect(readPackageVersion(path.join(dir, 'package.json'))).toBe('unknown');
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'crbro-memory', version: '9.9.9' }));
      expect(readPackageVersion(path.join(dir, 'package.json'))).toBe('9.9.9');
      expect(versionStatus('2.9.0', 'unknown')).toEqual({ crbro_version: '2.9.0' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── Through the tools ───────────────────────────────────────────

describe('through the MCP tools', () => {
  let holder: string;
  let root: string;
  let client: Client;
  const json = async (name: string, args: Record<string, unknown> = {}) =>
    JSON.parse(((await client.callTool({ name, arguments: args })) as any).content[0].text);

  const MINED = '- x Navigate to https://panel.ejemplo-garza.dev/ajustes y revisar el formulario de alta.';
  const RECORD = 'RECHAZO de la extensión Garza v3.4.0 en la tienda (9 jul 2026): permisos no justificados.';
  const STATE = 'Desde el 18-sep-2026 el panel de Garza escucha en el puerto 9443.';
  let garza = '';

  beforeAll(async () => {
    holder = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-stale-noise-'));
    root = path.join(holder, 'brain');
    await fs.mkdir(root, { recursive: true });
    process.env.CRBRO_PATH = root;
    vi.resetModules();
    const { createServer } = await import('../src/server.js');
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer().connect(st);
    client = new Client({ name: 'staleness-noise-test', version: '1.0.0' });
    await client.connect(ct);
    await json('crbro_boot');
    for (const content of [RECORD, STATE, MINED]) {
      garza = (await json('crbro_learn', { topic: 'Garza', type: 'fact', content, keywords: ['garza'] })).neuron_id;
    }
    // The miner line marked as the miner writes it (source "miner"), then
    // everything aged 300 days through the file: no CRBRO writes a past date.
    const file = path.join(root, 'cortex', `${garza}.json`);
    const n = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const f of n.facts) {
      f.added = new Date(Date.now() - 300 * DAY).toISOString();
      if (f.text === MINED) f.source = 'miner';
    }
    await fs.writeFile(file, JSON.stringify(n, null, 2));
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    delete process.env.CRBRO_PATH;
    await fs.rm(holder, { recursive: true, force: true });
  });

  it('learn returns the class: history for the record, volatile for the dated state', async () => {
    const r = await json('crbro_learn', { topic: 'Garza', type: 'fact', content: 'Auditoría completa 13/06/2026 del panel de Garza en garza.example.com.' });
    expect(r).toMatchObject({ shelf_life: 'permanent', shelf_inferred: true, shelf_reason: 'history' });
    const s = await json('crbro_learn', { topic: 'Garza', type: 'fact', content: 'A 4-oct-2026 el plan Equipo de Garza cuesta 35 €.' });
    expect(s).toMatchObject({ shelf_life: 'volatile', shelf_inferred: true, shelf_reason: 'price' });
  });

  it('at 300 days the miner line and the record stay in results; the dated state moves to possibly_stale', async () => {
    const neuron = JSON.parse(await fs.readFile(path.join(root, 'cortex', `${garza}.json`), 'utf8'));
    expect(neuron.facts.find((f: any) => f.text === MINED)?.source).toBe('miner');

    const mined = await json('crbro_recall', { query: 'Navigate panel ajustes formulario de alta Garza' });
    expect(mined.results.map((r: any) => r.matching_content)).toContain(MINED);
    expect((mined.possibly_stale || []).map((r: any) => r.last_known)).not.toContain(MINED);

    const record = await json('crbro_recall', { query: 'rechazo extensión Garza tienda' });
    expect(record.results.map((r: any) => r.matching_content)).toContain(RECORD);
    expect((record.possibly_stale || []).map((r: any) => r.last_known)).not.toContain(RECORD);

    const state = await json('crbro_recall', { query: 'panel Garza escucha puerto' });
    expect(state.possibly_stale?.map((r: any) => r.last_known)).toContain(STATE);
  });

  it('view=status: the running version, no note when the disk agrees', async () => {
    const st = await json('crbro_inspect', { view: 'status' });
    expect(st.crbro_version).toBe(RUNNING_VERSION);
    expect(st.installed_version).toBeUndefined();
    expect(st.version_note).toBeUndefined();
  });
});

describe('view=status when npx replaced the package under a running process', () => {
  it('keeps the version it runs and adds the one on disk, with the note', async () => {
    const holder = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-version-status-'));
    process.env.CRBRO_PATH = path.join(holder, 'brain');
    vi.resetModules();
    // The module loaded at start-up saw 2.9.0; the disk now says 2.9.1.
    vi.doMock('../src/version.js', async (importOriginal) => {
      const orig = await importOriginal<typeof import('../src/version.js')>();
      return { ...orig, RUNNING_VERSION: '2.9.0', versionStatus: () => orig.versionStatus('2.9.0', '2.9.1') };
    });
    try {
      const { createServer } = await import('../src/server.js');
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await createServer().connect(st);
      const client = new Client({ name: 'version-test', version: '1.0.0' });
      await client.connect(ct);
      await client.callTool({ name: 'crbro_boot', arguments: {} });
      const r: any = await client.callTool({ name: 'crbro_inspect', arguments: { view: 'status' } });
      const body = JSON.parse(r.content[0].text);
      expect(body).toMatchObject({ crbro_version: '2.9.0', installed_version: '2.9.1' });
      expect(body.version_note).toMatch(/restart the client/);
      expect(r.structuredContent.status.installed_version).toBe('2.9.1');
      expect(client.getServerVersion()?.version).toBe('2.9.0');
      await client.close();
    } finally {
      vi.doUnmock('../src/version.js');
      vi.resetModules();
      delete process.env.CRBRO_PATH;
      await fs.rm(holder, { recursive: true, force: true });
    }
  });
});
