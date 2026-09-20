// ─── One process owns the brain (2.5) ────────────────────────────
//
// Before the daemon, every client ran its own CRBRO with its own copy of the
// index in memory, and each wrote that copy over the others' when it closed.
// The tests below pin what the daemon is for — a line saved in one
// conversation is recalled in another at once — and, more of them, what it
// must never cost: the memory stays available when there is no daemon, when
// the daemon dies mid-call, and when something else answers on its name.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { LineReader } from '../src/daemon/lines.js';
import {
  endpointFor, stateFile, writeState, readState, newToken, proof, daemonEnabled, setDaemonEnabled, DAEMON_PROTOCOL,
} from '../src/daemon/endpoint.js';
import { runProxy, connectDaemon, controlDaemon, type ProxyHandle } from '../src/daemon/proxy.js';
import type { DaemonHandle } from '../src/daemon/daemon.js';

let holder: string;
let root: string;
let startDaemon: typeof import('../src/daemon/daemon.js').startDaemon;
let seq = 0;
const newBuild = () => `test-${process.pid}-${++seq}`;
const body = (r: any) => JSON.parse(r.content[0].text);

/** An MCP client whose "stdio" is a proxy: exactly what a real client launches in daemon mode. */
class ProxiedClient {
  toProxy = new PassThrough();
  fromProxy = new PassThrough();
  client = new Client({ name: 'daemon-test', version: '1.0.0' });
  proxy!: ProxyHandle;
  raw: string[] = [];

  async open(opts: { build: string; spawnDaemon?: (() => void | Promise<void>) | null; spawnWaitMs?: number }) {
    this.proxy = runProxy({ input: this.toProxy, output: this.fromProxy, brainRoot: root, spawnWaitMs: 4_000, ...opts });
    const self = this;
    const transport: Transport = {
      async start() {
        const reader = new LineReader(line => { self.raw.push(line); transport.onmessage?.(JSON.parse(line) as JSONRPCMessage); }, () => undefined);
        self.fromProxy.on('data', (c: Buffer) => reader.push(c));
      },
      async send(m: JSONRPCMessage) { self.toProxy.write(`${JSON.stringify(m)}\n`); },
      async close() { self.toProxy.end(); },
    };
    await this.client.connect(transport);
    return this;
  }
  call(name: string, args: Record<string, unknown> = {}) {
    return this.client.callTool({ name, arguments: args }) as Promise<any>;
  }
  async close() { await this.client.close(); await this.proxy.closed; }
}

beforeAll(async () => {
  holder = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-daemon-'));
  root = path.join(holder, 'brain');
  await fs.mkdir(root, { recursive: true });
  process.env.CRBRO_PATH = root;
  ({ startDaemon } = await import('../src/daemon/daemon.js'));
});

afterAll(async () => {
  delete process.env.CRBRO_PATH;
  await fs.rm(holder, { recursive: true, force: true });
});

describe('two conversations, one daemon', () => {
  let daemon: DaemonHandle;
  let a: ProxiedClient;
  let b: ProxiedClient;
  const build = `shared-${process.pid}`;

  beforeAll(async () => {
    daemon = await startDaemon({ build, idleMinutes: 0, log: () => undefined });
    a = await new ProxiedClient().open({ build, spawnDaemon: null });
    b = await new ProxiedClient().open({ build, spawnDaemon: null });
    await a.call('crbro_boot');
    await b.call('crbro_boot');
  });
  afterAll(async () => {
    await a.close();
    await b.close();
    await daemon.stop();
  });

  it('both are served by the daemon, not by themselves', () => {
    expect(a.proxy.backendKind()).toBe('daemon');
    expect(b.proxy.backendKind()).toBe('daemon');
    expect(daemon.connections()).toBe(2);
  });

  it('what one saves, the other recalls at once — the index is one', async () => {
    await a.call('crbro_learn', { topic: 'Albatros', type: 'fact', content: 'La API de staging de Albatros escucha en el puerto 8443.' });
    const hit = body(await b.call('crbro_recall', { query: 'puerto API staging Albatros' })).results[0];
    expect(hit.matching_content).toContain('8443');
  });

  it('each conversation consolidates what IT wrote, not what the process wrote', async () => {
    await b.call('crbro_learn', { topic: 'Ferralia', type: 'fact', content: 'El contacto técnico de Ferralia es Noelia Urrutia.' });
    await b.call('crbro_learn', { topic: 'Ferralia', type: 'decision', content: 'Facturar a Ferralia el día 1' });
    const deA = body(await a.call('crbro_consolidate', { summary: 'Sesión A: Albatros.' }));
    expect(deA.facts_saved).toBe(1);
    expect(deA.decisions_saved).toBe(0);
    expect(deA.topics_logged).toEqual(['project_albatros']);
    const deB = body(await b.call('crbro_consolidate', { summary: 'Sesión B: Ferralia.' }));
    expect(deB.facts_saved).toBe(1);
    expect(deB.decisions_saved).toBe(1);
    expect(deB.topics_logged).toEqual(['project_ferralia']);
  });

  it('answers a status question and leaves the two conversations alone', async () => {
    const s = await controlDaemon(root, 'status', build);
    expect(s).toMatchObject({ crbro: 'status', pid: process.pid, connections: 2, brain: root });
    expect(daemon.connections()).toBe(2);
  });

  it('a second daemon for the same brain and build gives way', async () => {
    await expect(startDaemon({ build, idleMinutes: 0, log: () => undefined })).rejects.toThrow('DAEMON_ALREADY_RUNNING');
    expect((await readState(root, build))?.pid).toBe(process.pid);
  });
});

describe('who gets in', () => {
  it('a client without the token is refused, and the daemon keeps serving the ones with it', async () => {
    const build = newBuild();
    const daemon = await startDaemon({ build, idleMinutes: 0, log: () => undefined });
    const real = (await readState(root, build))!;
    await writeState(root, { ...real, token: newToken() });          // what a client that guessed would hold
    expect(await connectDaemon(root, build)).toBeNull();
    await writeState(root, real);
    const ok = await connectDaemon(root, build);
    expect(ok).not.toBeNull();
    ok!.socket.destroy();
    await daemon.stop();
  });

  it('a process squatting the name learns nothing: the daemon proves itself first', async () => {
    const build = newBuild();
    const endpoint = endpointFor(root, build);
    const heard: string[] = [];
    const squatter = net.createServer(s => {
      const r = new LineReader(line => {
        heard.push(line);
        s.write(`${JSON.stringify({ crbro: 'hello', protocol: DAEMON_PROTOCOL, proof: proof(newToken(), 'daemon', JSON.parse(line).nonce), nonce: 'f'.repeat(32) })}\n`);
      }, () => undefined);
      s.on('data', c => r.push(c as Buffer));
      s.on('error', () => undefined);
    });
    await fs.mkdir(path.dirname(stateFile(root, build)), { recursive: true });
    await new Promise<void>(res => squatter.listen(endpoint, res));
    await writeState(root, { protocol: DAEMON_PROTOCOL, pid: 1, version: 'x', build, endpoint, token: newToken(), started: '', brain: root });

    expect(await connectDaemon(root, build)).toBeNull();
    expect(heard).toHaveLength(1);                                    // the hello, and only the hello
    expect(heard[0]).not.toContain('proof');                          // we never proved ourselves to it
    await new Promise<void>(res => squatter.close(() => res()));
  });
});

describe('the memory never depends on the daemon', () => {
  it('no daemon and none to be had: the proxy serves from its own process', async () => {
    const c = await new ProxiedClient().open({ build: newBuild(), spawnDaemon: null });
    expect(c.proxy.backendKind()).toBe('local');
    await c.call('crbro_boot');
    await c.call('crbro_learn', { topic: 'Sin demonio', type: 'fact', content: 'Esto se guardó sin ningún demonio en marcha.' });
    expect(body(await c.call('crbro_recall', { query: 'guardó sin demonio' })).results[0].matching_content).toContain('sin ningún demonio');
    await c.close();
  });

  it('starts one when it can, and the next client finds it running', async () => {
    const build = newBuild();
    let started: DaemonHandle | null = null;
    const spawnDaemon = async () => { started = await startDaemon({ build, idleMinutes: 0, log: () => undefined }); };
    const first = await new ProxiedClient().open({ build, spawnDaemon });
    expect(first.proxy.backendKind()).toBe('daemon');
    const second = await new ProxiedClient().open({ build, spawnDaemon: () => { throw new Error('must not spawn a second one'); } });
    expect(second.proxy.backendKind()).toBe('daemon');
    expect(started!.connections()).toBe(2);
    await first.close();
    await second.close();
    await started!.stop();
  });

  it('the daemon dies mid-conversation: the handshake is replayed on its replacement and the client never knows', async () => {
    const build = newBuild();
    let current = await startDaemon({ build, idleMinutes: 0, log: () => undefined });
    const c = await new ProxiedClient().open({
      build,
      spawnDaemon: async () => { current = await startDaemon({ build, idleMinutes: 0, log: () => undefined }); },
    });
    await c.call('crbro_boot');
    await c.call('crbro_learn', { topic: 'Resistente', type: 'fact', content: 'Guardado antes de que el demonio muriera.' });

    await current.stop('killed by the test');
    // The very next call is made against a daemon that does not exist yet.
    const r = body(await c.call('crbro_recall', { query: 'guardado antes demonio muriera' }));
    expect(r.results[0].matching_content).toContain('antes de que el demonio muriera');
    expect(c.proxy.reconnects()).toBe(1);
    expect(c.proxy.backendKind()).toBe('daemon');
    // One initialize answer reached the client, not two: the replay was swallowed.
    expect(c.raw.filter(l => l.includes('"serverInfo"'))).toHaveLength(1);
    await c.close();
    await current.stop();
  });

  it('a call in flight when the daemon vanishes gets an error, not a silence — and the next call works', async () => {
    const build = newBuild();
    const endpoint = endpointFor(root, build);
    const token = newToken();
    // A daemon that completes the handshake, answers initialize, then dies on the first real call.
    const dying = net.createServer(s => {
      let stage = 0;
      const r = new LineReader(line => {
        const m = JSON.parse(line);
        if (stage === 0) { stage = 1; s.write(`${JSON.stringify({ crbro: 'hello', protocol: DAEMON_PROTOCOL, proof: proof(token, 'daemon', m.nonce), nonce: 'a'.repeat(32) })}\n`); return; }
        if (stage === 1) { stage = 2; s.write(`${JSON.stringify({ crbro: 'ready' })}\n`); return; }
        if (m.method === 'initialize') {
          s.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'dying', version: '0' } } })}\n`);
          return;
        }
        if (m.method === 'tools/call') { s.destroy(); dying.close(); void fs.rm(stateFile(root, build), { force: true }); }
      }, () => undefined);
      s.on('data', c => r.push(c as Buffer));
      s.on('error', () => undefined);
    });
    await fs.mkdir(path.dirname(stateFile(root, build)), { recursive: true });
    await new Promise<void>(res => dying.listen(endpoint, res));
    await writeState(root, { protocol: DAEMON_PROTOCOL, pid: 1, version: 'x', build, endpoint, token, started: '', brain: root });

    const c = await new ProxiedClient().open({ build, spawnDaemon: null });
    expect(c.proxy.backendKind()).toBe('daemon');
    await expect(c.call('crbro_boot')).rejects.toThrow(/restarted while this call was running/);
    // No daemon left and none to start: the proxy is now CRBRO itself, handshake replayed.
    const boot = body(await c.call('crbro_boot'));
    expect(boot.status).toBe('ok');
    expect(c.proxy.backendKind()).toBe('local');
    await c.close();
  });
});

describe('lifecycle', () => {
  it('exits when nobody has needed it for a while, and cleans up after itself', async () => {
    const build = newBuild();
    const daemon = await startDaemon({ build, idleMinutes: 0.003, log: () => undefined });   // ~180 ms
    expect(await readState(root, build)).not.toBeNull();
    expect(await daemon.stopped).toBe('idle');
    expect(await readState(root, build)).toBeNull();
    expect(await connectDaemon(root, build)).toBeNull();
  });

  it('does not exit under a client, however long the client is quiet', async () => {
    const build = newBuild();
    const daemon = await startDaemon({ build, idleMinutes: 0.003, log: () => undefined });
    const c = await new ProxiedClient().open({ build, spawnDaemon: null });
    await new Promise(r => setTimeout(r, 450));
    expect(daemon.connections()).toBe(1);
    expect(body(await c.call('crbro_boot')).status).toBe('ok');
    await c.close();
    expect(await daemon.stopped).toBe('idle');
  });

  it('is off until asked, per brain, and one process can opt out', async () => {
    expect(daemonEnabled(root, {})).toBe(false);
    await setDaemonEnabled(root, true);
    expect(daemonEnabled(root, {})).toBe(true);
    expect(daemonEnabled(root, { CRBRO_DAEMON: '0' })).toBe(false);
    await setDaemonEnabled(root, false);
    expect(daemonEnabled(root, {})).toBe(false);
    expect(daemonEnabled(root, { CRBRO_DAEMON: '1' })).toBe(true);
  });
});
