// ─── Start-up, whatever the daemon is doing (2.11) ───────────────
//
// The 2.10 audit measured what a client saw in daemon mode: no answer to
// `initialize` until a backend existed (12 s and more when the daemon had to
// be started or was slow), quiet clients cut by the daemon every 5 s until the
// proxy gave up on daemons for good, two daemons for two installs of one
// release, and a .daemon folder full of descriptors nobody would ever clean.
// Each test below pins one of those down.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { LineReader, LoopbackTransport, SocketServerTransport, MAX_LINE_BYTES, NOT_STARTED, idFromHead } from '../src/daemon/lines.js';
import {
  endpointFor, stateFile, writeState, readState, newToken, proof, DAEMON_PROTOCOL, readBuildId, blockedSince,
  pruneDaemonDir, verifyDaemon, daemonDir, type DaemonState,
} from '../src/daemon/endpoint.js';
import { runProxy, connectDaemon } from '../src/daemon/proxy.js';
import { computeSurface, loadSurface, getSurface, SURFACE_FILE, type McpSurface } from '../src/daemon/surface.js';
import { createEngines, createServer } from '../src/server.js';
import { Brain } from '../src/engine/brain.js';

let holder: string;
let root: string;
let startDaemon: typeof import('../src/daemon/daemon.js').startDaemon;
let seq = 0;
const newBuild = () => `startup-${process.pid}-${++seq}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const initMsg = (id: number | string, protocolVersion = '2025-06-18') =>
  ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'startup-test', version: '1' } } });
const INITED = { jsonrpc: '2.0', method: 'notifications/initialized' };
const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

/** A client that writes raw lines and keeps every line it gets back, with the time it came. */
function rawClient(opts: Partial<Parameters<typeof runProxy>[0]> & { build: string }) {
  const input = new PassThrough();
  const output = new PassThrough();
  const got: any[] = [];
  const at = new Map<unknown, number>();
  const logs: string[] = [];
  const reader = new LineReader(l => { const m = JSON.parse(l); got.push(m); if (m.id !== undefined) at.set(m.id, Date.now()); }, () => undefined);
  output.on('data', (c: Buffer) => reader.push(c));
  const proxy = runProxy({ input, output, brainRoot: root, spawnDaemon: null, spawnWaitMs: 3_000, log: l => logs.push(l), ...opts });
  const send = (...msgs: unknown[]) => { for (const m of msgs) input.write(`${JSON.stringify(m)}\n`); };
  const answer = async (id: number | string, ms = 10_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const a = got.find(m => m.id === id && m.method === undefined); if (a) return a; await sleep(10); }
    throw new Error(`no answer to ${id}`);
  };
  const until = async (cond: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await sleep(20);
    return cond();
  };
  const end = async () => { input.end(); await proxy.closed; };
  return { input, proxy, send, answer, got, at, logs, until, end };
}

/** What the real server answers, asked directly — no proxy, no surface. */
async function realAnswers(requests: any[]): Promise<Map<unknown, any>> {
  const answers = new Map<unknown, any>();
  const t = new LoopbackTransport(line => { const m = JSON.parse(line); if (m.id !== undefined) answers.set(m.id, m); });
  const server = createServer(createEngines());
  await server.connect(t);
  for (const r of requests) t.receive(JSON.stringify(r));
  const end = Date.now() + 5_000;
  while (answers.size < requests.filter(r => r.id !== undefined).length && Date.now() < end) await sleep(5);
  await server.close();
  return answers;
}

beforeAll(async () => {
  holder = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-startup-'));
  root = path.join(holder, 'brain');
  await fs.mkdir(root, { recursive: true });
  process.env.CRBRO_PATH = root;
  await new Brain(root).initialize();                    // calls that are not crbro_boot need a brain to read
  ({ startDaemon } = await import('../src/daemon/daemon.js'));
});

afterAll(async () => {
  delete process.env.CRBRO_PATH;
  await fs.rm(holder, { recursive: true, force: true });
});

describe('the proxy answers initialize, ping and tools/list itself — exactly as the server would', () => {
  it('same answers as the real server, for every protocol version the SDK knows and one it does not', async () => {
    const build = newBuild();
    const surface = await computeSurface(build);
    const versions = [...surface.supported, '1999-01-01'];
    const reqs = [
      ...versions.map((v, i) => initMsg(`init-${i}`, v)),
      { jsonrpc: '2.0', id: 'ping', method: 'ping' },
      { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} },
    ];
    const real = await realAnswers(reqs);

    // A daemon that is never there: everything below is the proxy's own.
    const c = rawClient({ build, local: () => new Promise(() => undefined) });
    for (const r of reqs) c.send(r);
    for (const r of reqs) expect(await c.answer(r.id, 3_000), String(r.id)).toEqual(real.get(r.id));
    expect(real.get('tools').result.tools).toHaveLength(15);
    expect(real.get('init-0').result.protocolVersion).toBe(surface.latest);
    expect(real.get(`init-${versions.length - 1}`).result.protocolVersion).toBe(surface.latest);
    c.input.destroy();
  });

  it('the build-time snapshot is the same surface, and only the build it names may use it', async () => {
    const build = newBuild();
    const dir = path.join(holder, `snap-${seq}`);
    await fs.mkdir(dir, { recursive: true });
    const computed = await computeSurface(build);
    await fs.writeFile(path.join(dir, SURFACE_FILE), JSON.stringify(computed));
    expect(loadSurface(build, dir)).toEqual(computed);
    expect(loadSurface('another-build', dir)).toBeNull();
    expect(await getSurface(build)).toEqual(computed);   // no snapshot beside src: asked of the server here
  });

  it('initialize is answered in well under a second with no daemon reachable; the first call is served in-process once the budget is spent', async () => {
    const build = newBuild();
    const surface = await getSurface(build);           // what dist/mcp-surface.json holds in a build
    let spawned = 0;
    const t0 = Date.now();
    const c = rawClient({ build, surface, spawnWaitMs: 1_500, spawnDaemon: () => { spawned++; } });   // asked for, never comes
    c.send(initMsg(1), INITED, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, call(3, 'crbro_inspect', { view: 'status' }));
    await c.answer(1);
    expect(c.at.get(1)! - t0).toBeLessThan(1_000);
    expect(c.at.get(2)! - t0).toBeLessThan(1_000);
    const r = await c.answer(3, 15_000);
    expect(r.result.isError).toBeFalsy();
    expect(c.proxy.backendKind()).toBe('local');
    expect(spawned).toBe(1);
    expect(c.at.get(3)! - t0).toBeLessThan(1_500 + 6_000);   // the budget, then the in-process server
    await c.end();
  }, 20_000);

  it('a request the proxy cannot answer itself is never answered twice, and the backend never sees two initializes reach the client', async () => {
    const build = newBuild();
    const daemon = await startDaemon({ build, idleMinutes: 0, log: () => undefined });
    const c = rawClient({ build });
    c.send(initMsg(1), INITED, call(2, 'crbro_boot'), { jsonrpc: '2.0', id: 3, method: 'ping' });
    await c.answer(2);
    await sleep(50);
    expect(c.got.filter(m => m.id === 1)).toHaveLength(1);
    expect(c.got.filter(m => m.id === 2)).toHaveLength(1);
    expect(c.got.filter(m => typeof m.id === 'string' && m.id.startsWith('crbro-replay'))).toEqual([]);
    expect(c.proxy.backendKind()).toBe('daemon');
    await c.end();
    await daemon.stop();
  });
});

describe('a quiet client is not a dead one', () => {
  it('an authenticated connection that says nothing for 6 s is still served — no handshake timeout, no reconnection', async () => {
    const build = newBuild();
    const daemonLog: string[] = [];
    const daemon = await startDaemon({ build, idleMinutes: 0, log: l => daemonLog.push(l) });
    const c = rawClient({ build });
    expect(await c.until(() => c.proxy.backendKind() === 'daemon')).toBe(true);
    await sleep(6_000);                                    // longer than the daemon's 5 s handshake clock
    c.send(initMsg(1), INITED, call(2, 'crbro_inspect', { view: 'status' }));
    expect((await c.answer(2)).result.isError).toBeFalsy();
    expect(c.proxy.reconnects()).toBe(0);
    expect(c.proxy.backendKind()).toBe('daemon');
    expect(daemonLog.filter(l => /handshake timeout/.test(l))).toEqual([]);
    await c.end();
    await daemon.stop();
  }, 20_000);

  it('the clock still runs for a connection that never proves itself', async () => {
    const build = newBuild();
    const daemonLog: string[] = [];
    const daemon = await startDaemon({ build, idleMinutes: 0, log: l => daemonLog.push(l) });
    const s = net.connect(daemon.endpoint);
    s.on('error', () => undefined);
    const closedAt = await new Promise<number>(r => s.on('close', () => r(Date.now())));
    expect(daemonLog.some(l => /handshake timeout/.test(l))).toBe(true);
    void closedAt;
    await daemon.stop();
  }, 15_000);
});

describe('no fallback is for ever', () => {
  it('a daemon that arrives after the budget: the proxy serves in-process, then moves back once it answers — and what was written meanwhile is found through it', async () => {
    const build = newBuild();
    let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
    const c = rawClient({
      build, spawnWaitMs: 600, probeMs: { min: 150, max: 400 },
      // Asked for now, listening only in 1.5 s: too late for the budget.
      spawnDaemon: () => { setTimeout(() => { void startDaemon({ build, idleMinutes: 0, log: () => undefined }).then(d => { daemon = d; }); }, 1_500); },
    });
    c.send(initMsg(1), INITED, call(2, 'crbro_boot'));
    await c.answer(2);
    expect(c.proxy.backendKind()).toBe('local');
    c.send(call(3, 'crbro_learn', { topic: 'Vuelta al demonio', type: 'fact', content: 'Escrito en proceso mientras el demonio tardaba en llegar.' }));
    expect((await c.answer(3)).result.isError).toBeFalsy();

    expect(await c.until(() => c.proxy.backendKind() === 'daemon', 10_000)).toBe(true);
    expect(c.proxy.switches()).toBe(1);
    expect(c.logs.join('\n')).toMatch(/moved back/);
    c.send(call(4, 'crbro_recall', { query: 'escrito en proceso demonio tardaba' }));
    const r = JSON.parse((await c.answer(4)).result.content[0].text);
    expect(r.results[0].matching_content).toContain('mientras el demonio tardaba');
    expect(daemon!.connections()).toBe(1);
    await c.end();
    await daemon!.stop();
  }, 25_000);

  it('three lost daemons in a minute mean a pause, not for ever: after it the proxy is back on a daemon', async () => {
    const build = newBuild();
    let current = await startDaemon({ build, idleMinutes: 0, log: () => undefined });
    const c = rawClient({
      build, flapCooldownMs: 800, probeMs: { min: 150, max: 300 },
      spawnDaemon: async () => { current = await startDaemon({ build, idleMinutes: 0, log: () => undefined }); },
    });
    c.send(initMsg(1), INITED, call(2, 'crbro_boot'));
    await c.answer(2);
    for (let i = 0; i < 3; i++) {
      const before = c.proxy.reconnects();
      await current.stop('killed by the test');
      expect(await c.until(() => c.proxy.reconnects() === before + 1 && c.proxy.backendKind() !== 'none')).toBe(true);
    }
    expect(c.logs.join('\n')).toMatch(/lost 3 times in a minute: serving in-process for 1 s, then looking again/);
    expect(c.proxy.backendKind()).toBe('local');
    // A daemon is there again (the test starts it: probes never spawn one).
    current = await startDaemon({ build, idleMinutes: 0, log: () => undefined });
    expect(await c.until(() => c.proxy.backendKind() === 'daemon', 10_000)).toBe(true);
    c.send(call(9, 'crbro_inspect', { view: 'status' }));
    expect((await c.answer(9)).result.isError).toBeFalsy();
    await c.end();
    await current.stop();
  }, 30_000);
});

describe('budgets that hold', () => {
  it('a daemon that accepts and never answers costs the attempt its own deadline, not 9.5 s', async () => {
    const build = newBuild();
    const endpoint = endpointFor(root, build);
    const mute = net.createServer(s => { s.resume(); s.on('error', () => undefined); });   // reads, never answers
    await fs.mkdir(daemonDir(root), { recursive: true });
    await new Promise<void>(res => mute.listen(endpoint, res));
    await writeState(root, { protocol: DAEMON_PROTOCOL, pid: 1, version: 'x', build, endpoint, token: newToken(), started: '', brain: root });

    let t = Date.now();
    expect(await connectDaemon(root, build, { deadline: Date.now() + 400 })).toBeNull();
    expect(Date.now() - t).toBeLessThan(1_000);

    t = Date.now();
    const c = rawClient({ build, spawnWaitMs: 1_000, spawnDaemon: () => undefined });
    c.send(initMsg(1), INITED, call(2, 'crbro_inspect', { view: 'status' }));
    expect((await c.answer(2)).result.isError).toBeFalsy();
    expect(c.proxy.backendKind()).toBe('local');
    expect(Date.now() - t).toBeLessThan(1_000 + 5_000);   // budget + in-process start, never the old ~21 s
    await c.end();
    await new Promise<void>(res => mute.close(() => res()));
  }, 20_000);

  it('a daemon that cannot write its descriptor says so at once — in its log, and to the waiting proxy — and leaves no temporary', async () => {
    const build = newBuild();
    // The descriptor's name is taken by a folder: the rename fails every time.
    await fs.mkdir(stateFile(root, build), { recursive: true });
    const daemonLog: string[] = [];
    const t = Date.now();
    const c = rawClient({
      build, spawnWaitMs: 10_000,
      spawnDaemon: () => { void startDaemon({ build, idleMinutes: 0, log: l => daemonLog.push(l) }).catch(() => undefined); },
    });
    c.send(initMsg(1), INITED, call(2, 'crbro_inspect', { view: 'status' }));
    expect((await c.answer(2, 12_000)).result.isError).toBeFalsy();
    expect(c.proxy.backendKind()).toBe('local');
    expect(Date.now() - t).toBeLessThan(6_000);           // not the 10 s budget
    expect(daemonLog.join('\n')).toMatch(/could not write its descriptor/);
    expect(await blockedSince(root, build, t - 1_000)).toMatch(/descriptor/);
    expect((await fs.readdir(daemonDir(root))).filter(f => f.endsWith('.tmp'))).toEqual([]);
    expect(await connectDaemon(root, build)).toBeNull();
    await c.end();
    await fs.rm(stateFile(root, build), { recursive: true, force: true });
  }, 20_000);
});

describe('stopping does not cut a call in half', () => {
  it('a transport asked to drain waits for the call it is running and refuses new ones as not started', async () => {
    const [a, b] = await new Promise<[net.Socket, net.Socket]>(resolve => {
      let cli: net.Socket;
      const srv = net.createServer(s => { srv.close(); resolve([s, cli]); });
      srv.listen(0, '127.0.0.1', () => { cli = net.connect((srv.address() as net.AddressInfo).port, '127.0.0.1'); });
    });
    const t = new SocketServerTransport(a, fn => fn());
    const seen: any[] = [];
    t.onmessage = m => seen.push(m);
    await t.start();
    t.open();
    const fromServer: any[] = [];
    const r = new LineReader(l => fromServer.push(JSON.parse(l)), () => undefined);
    b.on('data', d => r.push(d as Buffer));

    t.receive(JSON.stringify(call(1, 'slow')));
    expect(t.inFlight()).toBe(1);
    let drained = false;
    const d = t.drain().then(() => { drained = true; });
    t.receive(JSON.stringify(call(2, 'late')));
    await sleep(50);
    expect(drained).toBe(false);
    expect(seen.map(m => m.id)).toEqual([1]);              // the late one never reached the server
    expect(fromServer.find(m => m.id === 2)?.error?.data?.crbro).toBe(NOT_STARTED);
    await t.send({ jsonrpc: '2.0', id: 1, result: { ok: true } } as any);
    await d;
    expect(drained).toBe(true);
    a.destroy(); b.destroy();
  });

  it('a call the daemon refuses while stopping is sent again to the next backend: the client gets an answer, not an error', async () => {
    const build = newBuild();
    const endpoint = endpointFor(root, build);
    const token = newToken();
    // A daemon that answers the handshake, then refuses the first call as not started and goes away.
    const stopping = net.createServer(s => {
      let stage = 0;
      const r = new LineReader(line => {
        const m = JSON.parse(line);
        if (stage === 0) { stage = 1; s.write(`${JSON.stringify({ crbro: 'hello', protocol: DAEMON_PROTOCOL, proof: proof(token, 'daemon', m.nonce), nonce: 'b'.repeat(32) })}\n`); return; }
        if (stage === 1) { stage = 2; s.write(`${JSON.stringify({ crbro: 'ready' })}\n`); return; }
        if (m.method === 'initialize') { s.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stopping', version: '0' } } })}\n`); return; }
        if (m.method === 'tools/call') {
          s.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'stopping', data: { crbro: NOT_STARTED } } })}\n`);
          setTimeout(() => { void fs.rm(stateFile(root, build), { force: true }); s.destroy(); stopping.close(); }, 30);
        }
      }, () => undefined);
      s.on('data', ch => r.push(ch as Buffer));
      s.on('error', () => undefined);
    });
    await fs.mkdir(daemonDir(root), { recursive: true });
    await new Promise<void>(res => stopping.listen(endpoint, res));
    await writeState(root, { protocol: DAEMON_PROTOCOL, pid: 1, version: 'x', build, endpoint, token, started: '', brain: root });

    const c = rawClient({ build });
    c.send(initMsg(1), INITED, call(2, 'crbro_learn', { topic: 'Reenviada', type: 'fact', content: 'Nunca empezó en el demonio que se iba.' }));
    const a = await c.answer(2);
    expect(a.error).toBeUndefined();
    expect(a.result.isError).toBeFalsy();
    expect(c.got.filter(m => m.id === 2)).toHaveLength(1);
    expect(c.proxy.backendKind()).toBe('local');
    const saved = JSON.parse(await fs.readFile(path.join(root, 'cortex', 'project_reenviada.json'), 'utf8'));
    expect(saved.facts.map((f: any) => f.text)).toEqual(['Nunca empezó en el demonio que se iba.']);
    await c.end();
  }, 20_000);

  it('a real daemon stopped right under a write: the write is answered and on disk, wherever it ran', async () => {
    const build = newBuild();
    const daemon = await startDaemon({ build, idleMinutes: 0, log: () => undefined });
    const c = rawClient({ build });
    c.send(initMsg(1), INITED, call(2, 'crbro_boot'));
    await c.answer(2);
    c.send(call(3, 'crbro_learn', { topic: 'Bajo la parada', type: 'fact', content: 'Guardado mientras el demonio se paraba.' }));
    await daemon.stop('asked to stop');
    const a = await c.answer(3);
    expect(a.error).toBeUndefined();
    expect(a.result.isError).toBeFalsy();
    const saved = JSON.parse(await fs.readFile(path.join(root, 'cortex', 'project_bajo_la_parada.json'), 'utf8'));
    expect(saved.facts.map((f: any) => f.text)).toEqual(['Guardado mientras el demonio se paraba.']);
    await c.end();
  }, 20_000);
});

describe('a line too long is an error, never two broken messages', () => {
  it('the reader reports it once, with its head, and skips to the next newline', () => {
    const lines: string[] = [];
    const over: string[] = [];
    const r = new LineReader(l => lines.push(l), h => over.push(h), 64);
    r.push(Buffer.from(`{"jsonrpc":"2.0","id":7,"method":"x","params":"${'a'.repeat(40)}`));
    r.push(Buffer.from(`${'b'.repeat(200)}`));
    r.push(Buffer.from(`${'c'.repeat(10)}"}\n{"id":8}\n`));
    expect(over).toHaveLength(1);
    expect(idFromHead(over[0])).toBe(7);
    expect(lines).toEqual(['{"id":8}']);
    // A long line that arrives whole, newline included, is refused too.
    r.push(Buffer.from(`{"id":"q","x":"${'z'.repeat(100)}"}\n{"id":9}\n`));
    expect(over).toHaveLength(2);
    expect(idFromHead(over[1])).toBe('q');
    expect(lines).toEqual(['{"id":8}', '{"id":9}']);
  });

  it('through the proxy: the client gets -32600 for that id, and the next message works', async () => {
    const build = newBuild();
    const c = rawClient({ build });
    c.send(initMsg(1), INITED);
    await c.answer(1);
    const big = `{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"crbro_recall","arguments":{"query":"${'x'.repeat(MAX_LINE_BYTES + 10)}"}}}\n`;
    c.input.write(big);
    const a = await c.answer(42);
    expect(a.error.code).toBe(-32600);
    c.send(call(43, 'crbro_inspect', { view: 'status' }));
    expect((await c.answer(43)).result.isError).toBeFalsy();
    expect(c.got.filter(m => m.id === null)).toEqual([]);  // no parse error for a half line
    await c.end();
  }, 30_000);
});

describe('one release, one daemon', () => {
  const tree = async (name: string, files: Record<string, string>) => {
    const dir = path.join(holder, name);
    for (const [f, body] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, 'dist', f)), { recursive: true });
      await fs.writeFile(path.join(dir, 'dist', f), body);
    }
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'crbro-memory', version: '9.9.9' }));
    execFileSync(process.execPath, [path.resolve('scripts/build-id.mjs'), path.join(dir, 'dist'), '--id-only'], { stdio: 'ignore' });
    return path.join(dir, 'dist');
  };
  const code = { 'server.js': 'module.exports = 1;\n', 'daemon/proxy.js': 'module.exports = 2;\n', 'index.js': '// entry\n' };

  it('two installs of the same build compute the same id, whatever their dates; a byte changed is another build', async () => {
    const a = await tree(`inst-a-${seq}`, code);
    await sleep(30);
    const b = await tree(`inst-b-${seq}`, code);
    const old = new Date('2020-01-01');
    await fs.utimes(path.join(b, 'server.js'), old, old);
    const idA = readBuildId(a);
    const idB = readBuildId(b);
    expect(idA).toMatch(/^9\.9\.9-[0-9a-f]{16}$/);
    expect(idB).toBe(idA);
    expect(endpointFor(root, idA!)).toBe(endpointFor(root, idB!));
    const c = await tree(`inst-c-${seq}`, { ...code, 'daemon/proxy.js': 'module.exports = 3;\n' });
    expect(readBuildId(c)).not.toBe(idA);
  });

  it('a tree recompiled without its stamp (tsc --watch) is not trusted with the old id', async () => {
    const a = await tree(`inst-w-${seq}`, code);
    expect(readBuildId(a)).not.toBeNull();
    await fs.writeFile(path.join(a, 'server.js'), 'module.exports = "edited";\n');
    expect(readBuildId(a)).toBeNull();
  });

  it('the second install finds the first one\'s daemon instead of starting its own', async () => {
    const a = readBuildId(await tree(`inst-d-${seq}`, code))!;
    const b = readBuildId(await tree(`inst-e-${seq}`, code))!;
    const daemon = await startDaemon({ build: a, idleMinutes: 0, log: () => undefined });
    await expect(startDaemon({ build: b, idleMinutes: 0, log: () => undefined })).rejects.toThrow('DAEMON_ALREADY_RUNNING');
    const link = await connectDaemon(root, b);
    expect(link && link !== 'config-mismatch').toBeTruthy();
    if (link && link !== 'config-mismatch') link.socket.destroy();
    await daemon.stop();
  });
});

describe('.daemon is cleaned of what dead daemons left', () => {
  it('a descriptor nobody answers for goes — even when its pid is alive (Windows reuses them); a live daemon and fresh files stay', async () => {
    const live = newBuild();
    const daemon = await startDaemon({ build: live, idleMinutes: 0, log: () => undefined });
    const dead = newBuild();
    // Its pid is this very process: alive, and not a daemon of that build. The old check called it alive.
    const ghost: DaemonState = { protocol: DAEMON_PROTOCOL, pid: process.pid, version: 'x', build: dead, endpoint: endpointFor(root, dead), token: newToken(), started: '2026-09-30T00:00:00Z', brain: root };
    await writeState(root, ghost);
    const dir = daemonDir(root);
    const oldTmp = path.join(dir, `${path.basename(stateFile(root, dead))}.4242.tmp`);
    const freshTmp = path.join(dir, `${path.basename(stateFile(root, dead))}.4343.tmp`);
    await fs.writeFile(oldTmp, '{"token":"x"}');
    await fs.writeFile(freshTmp, '{"token":"y"}');
    const longAgo = new Date(Date.now() - 3_600_000);
    await fs.utimes(oldTmp, longAgo, longAgo);

    expect(await verifyDaemon(ghost)).toBe('refused');
    expect(await verifyDaemon(daemon.state)).toBe('alive');
    const r = await pruneDaemonDir(root);
    expect(r.removed).toContain(path.basename(stateFile(root, dead)));
    expect(r.removed).toContain(path.basename(oldTmp));
    expect(r.removed).not.toContain(path.basename(freshTmp));
    expect(r.alive.map(s => s.build)).toContain(live);
    expect(await readState(root, dead)).toBeNull();
    expect(await readState(root, live)).not.toBeNull();
    await fs.rm(freshTmp, { force: true });
    await daemon.stop();
  });

  it('a descriptor whose endpoint is answered by somebody without its token is not called alive', async () => {
    const build = newBuild();
    const endpoint = endpointFor(root, build);
    const other = net.createServer(s => {
      const r = new LineReader(line => { s.write(`${JSON.stringify({ crbro: 'hello', protocol: DAEMON_PROTOCOL, proof: proof(newToken(), 'daemon', JSON.parse(line).nonce), nonce: 'c'.repeat(32) })}\n`); }, () => undefined);
      s.on('data', ch => r.push(ch as Buffer));
      s.on('error', () => undefined);
    });
    await fs.mkdir(daemonDir(root), { recursive: true });
    await new Promise<void>(res => other.listen(endpoint, res));
    const st: DaemonState = { protocol: DAEMON_PROTOCOL, pid: process.pid, version: 'x', build, endpoint, token: newToken(), started: '', brain: root };
    await writeState(root, st);
    expect(await verifyDaemon(st)).toBe('dead');
    await pruneDaemonDir(root);
    expect(await readState(root, build)).toBeNull();
    await new Promise<void>(res => other.close(() => res()));
  });

  it('a starting daemon sweeps the folder on its own', async () => {
    const dead = newBuild();
    await writeState(root, { protocol: DAEMON_PROTOCOL, pid: 999_999, version: 'x', build: dead, endpoint: endpointFor(root, dead), token: newToken(), started: '', brain: root });
    const daemon = await startDaemon({ build: newBuild(), idleMinutes: 0, log: () => undefined });
    const c = { until: async (cond: () => Promise<boolean>) => { const end = Date.now() + 5_000; while (!(await cond()) && Date.now() < end) await sleep(50); return cond(); } };
    expect(await c.until(async () => (await readState(root, dead)) === null)).toBe(true);
    await daemon.stop();
  });
});

describe('the surface a build ships', () => {
  it('describes the 15 tools and the server, and leaves resources and prompts undeclared (A8: answering them would mean advertising what CRBRO does not have)', async () => {
    const s: McpSurface = await computeSurface(newBuild());
    expect(s.tools.tools).toHaveLength(15);
    expect(s.initialize.serverInfo.name).toBe('crbro-memory');
    expect(Object.keys(s.initialize.capabilities)).toEqual(['tools']);
    expect(typeof s.initialize.instructions).toBe('string');
  });
});
