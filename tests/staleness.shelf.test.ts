// ─── Shelf life: the pure rules (detector, windows, age, grace) ──
//
// Everything that decides whether a line is "possibly stale" lives in
// src/engine/shelf.ts and takes its clock from the caller, so these tests pin
// it with fixed dates. Design: docs/design/staleness.md, sections 3 and 5.

import { describe, it, expect } from 'vitest';
import {
  detectShelf, shelfOfFact, shelfOfKind, shelfWindows, stalenessEnabled, stalenessContext,
  factStaleness, entryStaleness, mostVolatile, latestOf, DEFAULT_SHELF_DAYS,
} from '../src/engine/shelf.js';
import { entryId } from '../src/sync/ops.js';
import type { Fact, Neuron } from '../src/types/index.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const ctx = (since?: string) => ({ nowMs: NOW, windows: { ...DEFAULT_SHELF_DAYS }, ...(since ? { since } : {}) });
const fact = (text: string, extra: Partial<Fact> = {}): Fact => ({ text, confidence: 1, added: ago(0), source: 'session', status: 'active', ...extra });

describe('detectShelf: what makes a fact volatile', () => {
  const volatile: Array<[string, string]> = [
    ['La base de datos de Pelícano corre sobre PostgreSQL 14.', 'version'],
    ['The API runs on Node 22 in production.', 'version'],
    ['Usamos Python 3.12 en los workers.', 'version'],
    ['The current release is v2.3.1.', 'version'],
    ['crbro-memory 2.8.0 está publicada en npm.', 'version'],
    ['Instalada la versión 5 del plugin.', 'version'],
    ['El plan Equipo de Pelícano cuesta 29 euros al mes.', 'price'],
    ['The Pro plan is $49 per month.', 'price'],
    ['La tarifa básica es de 12 € al mes.', 'price'],
    ['El panel de administración de Pelícano escucha en el puerto 9090.', 'port'],
    ['The admin listens on port 8443.', 'port'],
    ['Postgres answers on localhost:5432.', 'port'],
    ['El acceso SSH es por clave; el puerto se movió al 2299.', 'port'],
    ['PHP queda con memory_limit de 512M en todas las instancias.', 'config'],
    ['El límite de subida está fijado en 64 MB.', 'config'],
    ['The VPS is at 203.0.113.10.', 'host'],
    ['The staging box is staging.example.com.', 'host'],
    ['Docs live at https://docs.example.org/guide.', 'url'],
    ['The vhost is in /etc/nginx/sites-enabled/app.conf.', 'path'],
    ['El proyecto está en C:\\code\\crbro.', 'path'],
    ['Los logs van a ~/logs/app.log.', 'path'],
    ['Production sets MAX_WORKERS=8.', 'config'],
    ['The request timeout is 30 seconds.', 'config'],
    ['Node runs with --max-old-space-size=4096.', 'config'],
    ['La responsable del soporte de Pelícano es Irene Zubiaurre.', 'role'],
    ['Our main contact at Acme is Laura Gómez.', 'role'],
    ['Marta es la jefa de proyecto.', 'role'],
    ['Ana is our CTO since spring.', 'role'],
  ];
  for (const [text, reason] of volatile) {
    it(`volatile (${reason}): ${text}`, () => {
      expect(detectShelf(text)).toEqual({ shelf: 'volatile', reason });
    });
  }

  // Prose with numbers or role words that is not a value: left normal on purpose.
  const normal = [
    'Pelícano es el servicio de facturación y se despliega con Docker Compose.',
    'Preferimos componentes pequeños y tests antes de refactorizar.',
    'Docker es responsable de aislar los servicios.',
    'Revisamos el backlog cada 3 meses.',
    'El equipo tiene 4 personas.',
    'La reunión fue el 04.10.2026 y salió bien.',
    'Nos vemos a las 10:30 en la oficina.',
    'La responsable del soporte es la persona de guardia.',
    'El puerto de Valencia queda cerca de la oficina.',
    'Tras el hackeo se tocó wp_options y se rotaron las salts.',
    'We moved from a monolith to services last year.',
    'El README explica cómo arrancar el proyecto.',
    '',
  ];
  for (const text of normal) {
    it(`normal: ${JSON.stringify(text)}`, () => {
      expect(detectShelf(text).shelf).toBe('normal');
    });
  }
});

describe('the class that applies', () => {
  it('an explicit shelf_life wins and is not inferred', () => {
    expect(shelfOfFact(fact('PostgreSQL 14', { shelf_life: 'durable' }))).toEqual({ shelf: 'durable', inferred: false });
    expect(shelfOfFact(fact('Nada que detectar aquí'))).toEqual({ shelf: 'normal', inferred: true });
    expect(shelfOfFact(fact('puerto 9090'))).toEqual({ shelf: 'volatile', inferred: true, reason: 'port' });
  });

  it('kinds other than facts take their class from the kind alone', () => {
    expect(shelfOfKind('decision')).toBe('durable');
    expect(shelfOfKind('pattern')).toBe('durable');
    expect(shelfOfKind('preference')).toBe('permanent');
    expect(shelfOfKind('error')).toBe('permanent');
    expect(shelfOfKind('debt')).toBe('permanent');
    expect(shelfOfKind('map')).toBeNull();
    expect(shelfOfKind('header')).toBeNull();
  });

  it('mostVolatile: volatile < normal < durable < permanent, absent loses', () => {
    expect(mostVolatile('durable', 'volatile')).toBe('volatile');
    expect(mostVolatile('permanent', 'normal')).toBe('normal');
    expect(mostVolatile(undefined, 'durable')).toBe('durable');
    expect(mostVolatile('normal', undefined)).toBe('normal');
    expect(mostVolatile(undefined, undefined)).toBeUndefined();
  });

  it('latestOf: the later instant, unparseable loses', () => {
    expect(latestOf('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')).toBe('2026-02-01T00:00:00Z');
    expect(latestOf('2026-03-01T00:00:00Z', 'garbage')).toBe('2026-03-01T00:00:00Z');
    expect(latestOf(undefined, undefined)).toBeUndefined();
  });
});

describe('windows and the kill switch', () => {
  it('defaults are 90 / 365 / 730', () => {
    expect(shelfWindows({})).toEqual({ volatile: 90, normal: 365, durable: 730 });
  });

  it('CRBRO_SHELF_DAYS overrides per class and ignores what it cannot read', () => {
    expect(shelfWindows({ CRBRO_SHELF_DAYS: 'volatile=30, durable=1000' })).toEqual({ volatile: 30, normal: 365, durable: 1000 });
    expect(shelfWindows({ CRBRO_SHELF_DAYS: 'volatile=0,normal=abc,permanent=5,durable=-3' })).toEqual({ volatile: 90, normal: 365, durable: 730 });
  });

  it('CRBRO_STALENESS=0 switches it off; anything else leaves it on', () => {
    expect(stalenessEnabled({ CRBRO_STALENESS: '0' })).toBe(false);
    expect(stalenessEnabled({ CRBRO_STALENESS: 'off' })).toBe(false);
    expect(stalenessEnabled({})).toBe(true);
    expect(stalenessEnabled({ CRBRO_STALENESS: '1' })).toBe(true);
    expect(stalenessContext('2026-01-01', { CRBRO_STALENESS: '0' })).toBeNull();
    expect(stalenessContext('2026-01-01', {}, NOW)).toEqual({ nowMs: NOW, windows: DEFAULT_SHELF_DAYS, since: '2026-01-01' });
  });
});

describe('age: verified ?? added, with the legacy grace', () => {
  const SINCE = ago(30);

  it('a volatile fact past 90 days is stale; at 90 it is not', () => {
    const s = factStaleness(fact('Escucha en el puerto 9090.', { added: ago(200) }), ctx(SINCE))!;
    expect(s).toMatchObject({ stale: true, age_days: 200, shelf_life: 'volatile', shelf_inferred: true, shelf_reason: 'port', window: 90 });
    expect(s.last_verified).toBe(ago(200).slice(0, 10));
    expect(s.age_from).toBeUndefined();   // volatile: no grace
    expect(factStaleness(fact('Escucha en el puerto 9090.', { added: ago(90) }), ctx(SINCE))!.stale).toBe(false);
  });

  it('verified restarts the clock', () => {
    const s = factStaleness(fact('Escucha en el puerto 9090.', { added: ago(400), verified: ago(10) }), ctx(SINCE))!;
    expect(s.stale).toBe(false);
    expect(s.age_days).toBe(10);
    expect(s.last_verified).toBe(ago(10).slice(0, 10));
  });

  it('an explicit class decides the window, even against the text', () => {
    expect(factStaleness(fact('Escucha en el puerto 9090.', { added: ago(200), shelf_life: 'permanent' }), ctx(SINCE))!.stale).toBe(false);
    const marked = factStaleness(fact('Una regla sin números.', { added: ago(100), shelf_life: 'volatile' }), ctx(SINCE))!;
    expect(marked).toMatchObject({ stale: true, shelf_life: 'volatile', shelf_inferred: false });
  });

  it('legacy grace: an old unmarked normal fact counts from staleness_since, and says so', () => {
    const s = factStaleness(fact('Nos reunimos los lunes.', { added: ago(800) }), ctx(SINCE))!;
    expect(s.stale).toBe(false);
    expect(s.age_days).toBe(30);
    expect(s.age_from).toBe(SINCE.slice(0, 10));
    expect(s.last_verified).toBe(ago(800).slice(0, 10));
    // A year and a bit after the stamp it does turn stale.
    const later = factStaleness(fact('Nos reunimos los lunes.', { added: ago(800) }), ctx(ago(400)))!;
    expect(later).toMatchObject({ stale: true, age_days: 400 });
  });

  it('no grace for an explicit class, nor once the fact was verified', () => {
    expect(factStaleness(fact('Nos reunimos los lunes.', { added: ago(800), shelf_life: 'normal' }), ctx(SINCE))!.stale).toBe(true);
    expect(factStaleness(fact('Nos reunimos los lunes.', { added: ago(900), verified: ago(500) }), ctx(SINCE))!.stale).toBe(true);
  });

  it('no stamp yet: the grace runs from now, so nothing non-volatile flips before the first boot', () => {
    expect(factStaleness(fact('Nos reunimos los lunes.', { added: ago(5000) }), ctx())!.stale).toBe(false);
    expect(factStaleness(fact('Puerto 9090.', { added: ago(5000) }), ctx())!.stale).toBe(true);
  });

  it('no date, no flag: an unparseable or missing date is never judged', () => {
    expect(factStaleness(fact('Puerto 9090.', { added: '' }), ctx(SINCE))).toBeNull();
    expect(factStaleness(fact('Puerto 9090.', { added: 'someday' }), ctx(SINCE))).toBeNull();
    // A broken verified stamp falls back to added, it does not make the line fresh.
    expect(factStaleness(fact('Puerto 9090.', { added: ago(200), verified: 'nope' }), ctx(SINCE))!.stale).toBe(true);
  });

  it('a clock in the future is age 0', () => {
    const s = factStaleness(fact('Puerto 9090.', { added: ago(-20) }), ctx(SINCE))!;
    expect(s.age_days).toBe(0);
    expect(s.stale).toBe(false);
  });

  it('retired facts are not judged', () => {
    expect(factStaleness(fact('Puerto 9090.', { added: ago(200), status: 'superseded' }), ctx(SINCE))).toBeNull();
  });

  it('entries: decisions and patterns are durable by kind, preferences/errors/debts never stale', () => {
    const pattern = 'Deploy: build, test, then tag.';
    const pref = 'Prefers tabs over spaces.';
    const n = {
      id: 'project_x', decisions: [{ text: 'Use Postgres.', date: ago(800), rationale: 'joins' }],
      patterns: [pattern], preferences: [pref], errors: [], debts: [],
      entry_dates: { [entryId(pattern)]: ago(1000), [entryId(pref)]: ago(5000) },
    } as unknown as Neuron;
    // Grace applies to durable kinds: stamped 30 days ago, nothing is stale yet.
    expect(entryStaleness(n, 'decision', 'Use Postgres. — joins', ctx(SINCE))!).toMatchObject({ stale: false, shelf_life: 'durable', age_from: SINCE.slice(0, 10) });
    // Stamped long ago: both past 730 days.
    expect(entryStaleness(n, 'decision', 'Use Postgres.', ctx(ago(760)))!.stale).toBe(true);
    expect(entryStaleness(n, 'pattern', pattern, ctx(ago(760)))!).toMatchObject({ stale: true, age_days: 760 });
    // entry_verified restarts the clock.
    n.entry_verified = { [entryId(pattern)]: ago(3) };
    expect(entryStaleness(n, 'pattern', pattern, ctx(ago(760)))!).toMatchObject({ stale: false, age_days: 3 });
    expect(entryStaleness(n, 'preference', pref, ctx(ago(760)))!.stale).toBe(false);
    expect(entryStaleness(n, 'map', 'x', ctx(SINCE))).toBeNull();
    // A pattern with no date is never flagged.
    expect(entryStaleness({ ...n, entry_dates: {}, entry_verified: {} } as Neuron, 'pattern', pattern, ctx(SINCE))).toBeNull();
  });
});
