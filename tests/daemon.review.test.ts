// ─── What an adversarial review of daemon mode found (2.5) ───────
//
// Daemon mode was reviewed through three lenses — lifecycle, trust, shared
// state — and every finding was handed to a skeptic told to refute it.
// Fourteen survived. Each test below is one of them, written to fail on the
// code as it was: the point of keeping them is that the same review, run
// again, finds nothing here.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { LineReader } from '../src/daemon/lines.js';
import {
  endpointFor, stateFile, writeState, readState, newToken, proof, configFingerprint, blockedSince, DAEMON_PROTOCOL,
} from '../src/daemon/endpoint.js';
import { runProxy, connectDaemon } from '../src/daemon/proxy.js';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { SearchEngine } from '../src/search/index.js';

let holder: string;
let root: string;
let startDaemon: typeof import('../src/daemon/daemon.js').startDaemon;
let idleDelayMs: typeof import('../src/daemon/daemon.js').idleDelayMs;
let seq = 0;
const newBuild = () => `review-${process.pid}-${++seq}`;

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } };
const INITED = { jsonrpc: '2.0', method: 'notifications/initialized' };
const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

/** A client that writes raw lines and keeps every line it gets back. */
function rawClient(opts: Partial<Parameters<typeof runProxy>[0]> & { build: string }) {
  const input = new PassThrough();
  const output = new PassThrough();
  const got: any[] = [];
  const reader = new LineReader(l => got.push(JSON.parse(l)), () => undefined);
  output.on('data', (c: Buffer) => reader.push(c));
  const proxy = runProxy({ input, output, brainRoot: root, spawnDaemon: null, spawnWaitMs: 3_000, ...opts });
  const send = (...msgs: unknown[]) => { for (const m of msgs) input.write(`${JSON.stringify(m)}\n`); };
  const answer = async (id: number | string, ms = 8_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const a = got.find(m => m.id === id && m.method === undefined); if (a) return a; await new Promise(r => setTimeout(r, 15)); }
    throw new Error(`no answer to ${id}`);
  };
  return { input, proxy, send, answer, got };
}

beforeAll(async () => {
  holder = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-dreview-'));
  root = path.join(holder, 'brain');
  await fs.mkdir(root, { recursive: true });
  process.env.CRBRO_PATH = root;
  ({ startDaemon, idleDelayMs } = await import('../src/daemon/daemon.js'));
});

afterAll(async () => {
  delete process.env.CRBRO_PATH;
  await fs.rm(holder, { recursive: true, force: true });
});

describe('the client closes right after its last call', () => {
  it('in-process fallback: the write happens and the answer comes out before the proxy lets go', async () => {
    const c = rawClient({ build: newBuild() });
    c.send(INIT, INITED, call(7, 'crbro_boot'));
    await c.answer(7);                                    // a real client waits for boot; it does not wait before hanging up
    c.send(call(2, 'crbro_learn', { topic: 'Ultima llamada local', type: 'fact', content: 'Guardado con el cliente ya yéndose.' }));
    c.input.end();                                        // EOF in the same breath as the call
    await c.proxy.closed;
    expect(c.got.find(m => m.id === 2)?.result?.isError).toBeFalsy();
    const saved = JSON.parse(await fs.readFile(path.join(root, 'cortex', 'project_ultima_llamada_local.json'), 'utf8'));
    expect(saved.facts.map((f: any) => f.text)).toEqual(['Guardado con el cliente ya yéndose.']);
  });

  it('through a daemon: same promise', async () => {
    const build = newBuild();
    const daemon = await startDaemon({ build, idleMinutes: 0, log: () => undefined });
    const c = rawClient({ build });
    c.send(INIT, INITED, call(7, 'crbro_boot'));
    await c.answer(7);                                    // a real client waits for boot; it does not wait before hanging up
    c.send(call(2, 'crbro_learn', { topic: 'Ultima llamada demonio', type: 'fact', content: 'Guardado a través del demonio, con EOF inmediato.' }));
    c.input.end();
    await c.proxy.closed;
    expect(c.got.find(m => m.id === 2)?.result?.isError).toBeFalsy();
    const saved = JSON.parse(await fs.readFile(path.join(root, 'cortex', 'project_ultima_llamada_demonio.json'), 'utf8'));
    expect(saved.facts.map((f: any) => f.text)).toEqual(['Guardado a través del demonio, con EOF inmediato.']);
    await daemon.stop();
  });
});

describe('`crbro daemon off` sticks', () => {
  it('a proxy that loses its daemon asks again whether daemons are wanted, and serves itself if not', async () => {
    const build = newBuild();
    let enabled = true;
    let spawned = 0;
    const daemon = await startDaemon({ build, idleMinutes: 0, log: () => undefined });
    const c = rawClient({ build, isEnabled: () => enabled, spawnDaemon: async () => { spawned++; await startDaemon({ build, idleMinutes: 0, log: () => undefined }); } });
    c.send(INIT, INITED, call(2, 'crbro_boot'));
    await c.answer(2);
    expect(c.proxy.backendKind()).toBe('daemon');

    enabled = false;                                      // what `daemon off` does, then it stops the daemon
    await daemon.stop();
    c.send(call(3, 'crbro_boot'));
    expect((await c.answer(3)).result).toBeTruthy();
    expect(c.proxy.backendKind()).toBe('local');
    expect(spawned).toBe(0);
    expect(await readState(root, build)).toBeNull();
    c.input.end();
    await c.proxy.closed;
  });
});

describe('when nothing can serve', () => {
  it('every call that is owed an answer gets an error, and the proxy stops instead of queueing forever', async () => {
    const c = rawClient({ build: newBuild(), local: async () => { throw new Error('the server module would not load'); } });
    c.send(INIT, call(2, 'crbro_boot'));
    await expect(c.proxy.closed).rejects.toThrow('would not load');
    expect(c.got.map(m => m.id).sort()).toEqual([1, 2]);
    expect(c.got.every(m => /could not start/.test(m.error?.message))).toBe(true);
  });
});

describe('an endpoint held by something that is not our daemon', () => {
  it('the daemon refuses to call it a sibling, says why, and the proxy stops waiting at once', async () => {
    const build = newBuild();
    const endpoint = endpointFor(root, build);
    await fs.mkdir(path.dirname(stateFile(root, build)), { recursive: true });
    const squatter = net.createServer(s => { s.on('error', () => undefined); });
    await new Promise<void>(res => squatter.listen(endpoint, res));

    const started = Date.now();
    const c = rawClient({
      build, spawnWaitMs: 12_000,
      spawnDaemon: () => { void startDaemon({ build, idleMinutes: 0, log: () => undefined }).catch(() => undefined); },
    });
    c.send(INIT, INITED, call(2, 'crbro_boot'));
    expect((await c.answer(2, 11_000)).result).toBeTruthy();
    expect(c.proxy.backendKind()).toBe('local');
    expect(Date.now() - started).toBeLessThan(8_000);     // the daemon's own 2.5 s of patience, not the proxy's 12
    expect(await blockedSince(root, build, started - 1_000)).toMatch(/does not prove/);
    c.input.end();
    await c.proxy.closed;
    await new Promise<void>(res => squatter.close(() => res()));
  }, 20_000);
});

describe('the handshake', () => {
  it('refuses a daemon that hands our own nonce back, or none at all', async () => {
    for (const mode of ['reflect', 'empty'] as const) {
      const build = newBuild();
      const endpoint = endpointFor(root, build);
      const token = newToken();
      const heard: any[] = [];
      const fake = net.createServer(s => {
        const r = new LineReader(line => {
          const m = JSON.parse(line);
          heard.push(m);
          if (m.crbro === 'hello') s.write(`${JSON.stringify({ crbro: 'hello', protocol: DAEMON_PROTOCOL, proof: proof(token, 'daemon', m.nonce), nonce: mode === 'reflect' ? m.nonce : '' })}\n`);
        }, () => undefined);
        s.on('data', c => r.push(c as Buffer));
        s.on('error', () => undefined);
      });
      await fs.mkdir(path.dirname(stateFile(root, build)), { recursive: true });
      await new Promise<void>(res => fake.listen(endpoint, res));
      await writeState(root, { protocol: DAEMON_PROTOCOL, pid: 1, version: 'x', build, endpoint, token, started: '', brain: root });
      expect(await connectDaemon(root, build), mode).toBeNull();
      expect(heard.filter(m => m.crbro === 'auth'), mode).toEqual([]);   // no proof of ours was ever bound to it
      await new Promise<void>(res => fake.close(() => res()));
    }
  });

  it('a client configured differently from the daemon serves itself, and says so', async () => {
    const build = newBuild();
    const daemon = await startDaemon({ build, idleMinutes: 0, log: () => undefined });
    expect(configFingerprint({})).not.toBe(configFingerprint({ CRBRO_BACKUP_DIR: 'D:/Drive/crbro' }));
    expect(configFingerprint({ CRBRO_SEMANTIC: 'off' })).toBe(configFingerprint({ CRBRO_SEMANTIC: '0' }));

    const before = process.env.CRBRO_BACKUP_DIR;
    process.env.CRBRO_BACKUP_DIR = path.join(holder, 'synced');       // this client's setting; the daemon started without it
    try {
      expect(await connectDaemon(root, build)).toBe('config-mismatch');
      expect(await connectDaemon(root, build, { checkConfig: false })).not.toBeNull();   // `daemon status` still reaches it
      const logs: string[] = [];
      const c = rawClient({ build, log: l => logs.push(l), spawnDaemon: () => { throw new Error('must not spawn a second daemon'); } });
      c.send(INIT, INITED, call(2, 'crbro_boot'));
      await c.answer(2);
      expect(c.proxy.backendKind()).toBe('local');
      expect(logs.join(' ')).toMatch(/other settings/);
      c.input.end();
      await c.proxy.closed;
    } finally {
      if (before === undefined) delete process.env.CRBRO_BACKUP_DIR; else process.env.CRBRO_BACKUP_DIR = before;
    }
    await daemon.stop();
  });
});

describe('the idle clock', () => {
  it('a month of patience is a month, not a millisecond', () => {
    expect(idleDelayMs(60 * 24 * 40)).toBeLessThanOrEqual(2_147_483_647);
    expect(idleDelayMs(60 * 24 * 40)).toBeGreaterThan(24 * 24 * 3_600_000);
    expect(idleDelayMs(undefined, { CRBRO_DAEMON_IDLE_MIN: '999999' })).toBeLessThanOrEqual(2_147_483_647);
    expect(idleDelayMs(0)).toBe(0);
  });

  it('sockets that never prove themselves neither keep the daemon alive nor postpone its exit', async () => {
    const build = newBuild();
    const daemon = await startDaemon({ build, idleMinutes: 0.004, log: () => undefined });   // ~240 ms
    const knocks: net.Socket[] = [];
    const knock = setInterval(() => { const s = net.connect(daemon.endpoint); s.on('error', () => undefined); knocks.push(s); }, 40);
    const reason = await Promise.race([daemon.stopped, new Promise<string>(r => setTimeout(() => r('still alive'), 2_500))]);
    clearInterval(knock);
    for (const s of knocks) s.destroy();
    expect(reason).toBe('idle');
  });
});

describe('a conversation that outlives its daemon', () => {
  it('consolidate admits its counters restarted, instead of reporting zeros as the truth', async () => {
    const build = newBuild();
    let current = await startDaemon({ build, idleMinutes: 0, log: () => undefined });
    const c = rawClient({ build, spawnDaemon: async () => { current = await startDaemon({ build, idleMinutes: 0, log: () => undefined }); } });
    c.send(INIT, INITED, call(2, 'crbro_boot'), call(3, 'crbro_learn', { topic: 'Antes del corte', type: 'fact', content: 'Escrito con el primer demonio.' }));
    await c.answer(3);
    await current.stop('killed by the test');
    c.send(call(4, 'crbro_consolidate', { summary: 'Sesión que sobrevivió a su demonio.' }));
    const r = JSON.parse((await c.answer(4)).result.content[0].text);
    expect(r.facts_saved).toBe(0);
    expect(r.tally_incomplete).toBe(true);
    expect(r.tally_incomplete_hint).toMatch(/topics_touched/);
    c.input.end();
    await c.proxy.closed;
    await current.stop();
  });
});

describe('the index under one roof', () => {
  let dir: string;
  const mk = async () => {
    const brain = new Brain(dir);
    await brain.initialize();
    const cortex = new Cortex(brain);
    const engine = new SearchEngine(brain);
    cortex.setIndexer(n => engine.indexNeuron(n));
    cortex.setRemover(id => engine.removeNeuron(id));
    return { brain, cortex, engine };
  };

  it('a neuron learned WHILE the index catches up is not mistaken for a deleted one', async () => {
    dir = await fs.mkdtemp(path.join(holder, 'race-'));
    const a = await mk();
    await a.engine.init();
    for (let i = 0; i < 120; i++) await a.cortex.learn(`Relleno ${i}`, 'fact', `Línea de relleno número ${i} para que ponerse al día tarde un poco.`);
    (a.engine as any).syncedAt = 0;                       // everything looks changed: the catch-up has real work to do
    const catchingUp = a.engine.refresh();
    await a.cortex.learn('Recién llegada', 'fact', 'Aprendida mientras el índice se ponía al día.');
    await catchingUp;
    expect((await a.engine.search('aprendida mientras índice ponía día'))[0]?.name).toBe('Recién llegada');
  });

  it('a recall that arrives during a rebuild waits for it instead of answering from a fraction of the brain', async () => {
    dir = await fs.mkdtemp(path.join(holder, 'rebuild-'));
    const a = await mk();
    await a.engine.init();
    for (let i = 0; i < 150; i++) await a.cortex.learn(`Tema ${i}`, 'fact', `Dato ${i} del cerebro grande.`);
    await a.cortex.learn('Último de todos', 'fact', 'El hecho zzzfinal que se indexa al final de la reconstrucción.');
    const rebuilding = a.engine.rebuild();
    const during = await a.engine.search('zzzfinal');     // asked while the index is being emptied and refilled
    await rebuilding;
    expect(during[0]?.matching_content).toContain('zzzfinal');
  });

  it('re-indexing a neuron keeps the vector of every line that is still there', async () => {
    dir = await fs.mkdtemp(path.join(holder, 'vectors-'));
    const a = await mk();
    await a.engine.init();
    const removed: string[][] = [];
    (a.engine as any).semantic = {
      remove: (ids: Iterable<string>) => { removed.push([...ids]); },
      ready: () => false, count: () => 0, persist: async () => undefined, upsert: async () => undefined,
    };
    const r = await a.cortex.learn('Vectores', 'fact', 'Primera línea, que no cambia.');
    await a.cortex.learn('Vectores', 'fact', 'Segunda línea, que tampoco.');
    removed.length = 0;
    await a.cortex.learn('Vectores', 'fact', 'Tercera línea, la nueva.');
    expect(removed.flat()).toEqual([]);                   // adding a line throws no vector away
    await a.cortex.revise(r.neuron!.id, ['Primera línea, que no cambia.'], { status: 'retracted' });
    expect(removed.flat()).toHaveLength(1);               // retiring one line removes that line's vector, and only that
  });
});
