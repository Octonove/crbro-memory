import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { detectBackend, getSecret, listSecrets, setSecret } from '../src/engine/keychain.js';

// Keep IO real; replace only the two failure boundaries in the disk-fault tests.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), writeFileSync: vi.fn(actual.writeFileSync) };
});

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
let build: string;
let dir: string;
let previousDir: string | undefined;
const workers: ChildProcess[] = [];

// Compile only the owned source files into a disposable directory, never dist/.
// Real processes exercise the current sources and real DPAPI, with fake values.
beforeAll(async () => {
  build = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-keychain-code-'));
  for (const file of ['engine/keychain', 'utils/lock']) {
    const source = await fs.readFile(path.resolve('src', `${file}.ts`), 'utf8');
    const output = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const dest = path.join(build, `${file}.js`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, output);
  }
});
afterAll(async () => { await fs.rm(build, { recursive: true, force: true }); });
beforeEach(async () => {
  previousDir = process.env.CRBRO_KEYS_DIR;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-keychain-concurrent-'));
  process.env.CRBRO_KEYS_DIR = dir;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(workers.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill();
  })));
  if (previousDir === undefined) delete process.env.CRBRO_KEYS_DIR;
  else process.env.CRBRO_KEYS_DIR = previousDir;
  await fs.rm(dir, { recursive: true, force: true });
});

async function worker() {
  const code = `
    if (!process.env.CRBRO_KEYS_DIR) process.exit(2);
    const api = require(process.argv[1]);
    process.on('message', ({id, method, args}) => {
      try { process.send({id, result: api[method](...args)}); }
      catch (e) { process.send({id, error: e.name}); }
    });
    process.send({ready: true});
  `;
  const child = spawn(process.execPath, ['-e', code, path.join(build, 'engine/keychain.js')], {
    env: { ...process.env, CRBRO_KEYS_DIR: dir },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  });
  workers.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('message', () => resolve());
    child.once('error', reject);
    child.once('exit', () => reject(new Error('fixture worker exited before ready')));
  });
  let nextId = 0;
  return (method: string, ...args: string[]) => new Promise<any>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { cleanup(); reject(new Error('fixture worker timed out')); }, 60_000);
    const onExit = () => { cleanup(); reject(new Error('fixture worker exited')); };
    const onMessage = (message: any) => {
      if (message.id !== id) return;
      cleanup();
      if (message.error) reject(new Error(`keychain operation failed: ${message.error}`));
      else resolve(message.result);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.send({ id, method, args });
  });
}

const windows = os.platform() === 'win32';
describe.runIf(windows)('DPAPI integrity across processes (temporary store only)', () => {
  it('preserves B when A writes again with a warm cache', async () => {
    expect(detectBackend().backend).toBe('windows-dpapi');
    const a = await worker(); const b = await worker();
    await a('setSecret', 'FIXTURE_A', 'fake-a');
    await b('setSecret', 'FIXTURE_B', 'fake-b');
    await a('setSecret', 'FIXTURE_C', 'fake-c');
    expect(listSecrets().map(e => e.name)).toEqual(['FIXTURE_A', 'FIXTURE_B', 'FIXTURE_C']);
  });

  it('preserves an external update during another cached write', async () => {
    const a = await worker(); const b = await worker();
    await a('setSecret', 'FIXTURE_ROTATE', 'fake-old');
    await b('setSecret', 'FIXTURE_ROTATE', 'fake-new');
    await a('setSecret', 'FIXTURE_A', 'fake-a');
    expect(getSecret('FIXTURE_ROTATE')).toBe('fake-new');
  });

  it('does not resurrect an externally deleted key from cache', async () => {
    const a = await worker(); const b = await worker();
    await a('setSecret', 'FIXTURE_DROP', 'fake-drop');
    expect(await b('removeSecret', 'FIXTURE_DROP')).toBe(true);
    await a('setSecret', 'FIXTURE_A', 'fake-a');
    expect(getSecret('FIXTURE_DROP')).toBeNull();
  });

  it('deletes from fresh state without losing another process addition', async () => {
    const a = await worker(); const b = await worker();
    await a('setSecret', 'FIXTURE_DROP', 'fake-drop');
    await b('setSecret', 'FIXTURE_KEEP', 'fake-keep');
    expect(await a('removeSecret', 'FIXTURE_DROP')).toBe(true);
    expect(listSecrets().map(e => e.name)).toEqual(['FIXTURE_KEEP']);
  });

  it('invalidates cached reads when another process updates or deletes', async () => {
    const a = await worker(); const b = await worker();
    await a('setSecret', 'FIXTURE_READ', 'fake-old');
    expect(await a('getSecret', 'FIXTURE_READ')).toBe('fake-old');
    await b('setSecret', 'FIXTURE_READ', 'fake-new');
    expect(await a('getSecret', 'FIXTURE_READ')).toBe('fake-new');
    await b('removeSecret', 'FIXTURE_READ');
    expect(await a('listSecrets')).toEqual([]);
  });

  it('serializes simultaneous add, update and delete operations', async () => {
    setSecret('FIXTURE_ROTATE', 'fake-old');
    setSecret('FIXTURE_DROP', 'fake-drop');
    const a = await worker(); const b = await worker(); const c = await worker();
    await Promise.all([
      a('setSecret', 'FIXTURE_ADDED', 'fake-added'),
      b('setSecret', 'FIXTURE_ROTATE', 'fake-new'),
      c('removeSecret', 'FIXTURE_DROP'),
    ]);
    expect(listSecrets().map(e => e.name)).toEqual(['FIXTURE_ADDED', 'FIXTURE_ROTATE']);
    expect(getSecret('FIXTURE_ROTATE')).toBe('fake-new');
  });

  it('does not reuse or erase another operation temporary file', async () => {
    await fs.writeFile(path.join(dir, 'keys.dpapi.tmp'), 'unrelated-fixture');
    setSecret('FIXTURE_A', 'fake-a');
    expect(await fs.readFile(path.join(dir, 'keys.dpapi.tmp'), 'utf8')).toBe('unrelated-fixture');
    expect((await fs.readdir(dir)).sort()).toEqual(['keys.dpapi', 'keys.dpapi.tmp']);
  });

  it('refuses to overwrite a truncated store with an apparently successful write', async () => {
    await fs.writeFile(path.join(dir, 'keys.dpapi'), '');
    expect(() => setSecret('FIXTURE_A', 'fake-a')).toThrow();
    expect(await fs.readFile(path.join(dir, 'keys.dpapi'), 'utf8')).toBe('');
    expect(await fs.readdir(dir)).toEqual(['keys.dpapi']);
  });

  it('preserves disk state and invalidates cache if atomic replacement fails', async () => {
    setSecret('FIXTURE_ROTATE', 'fake-old');
    const original = await fs.readFile(path.join(dir, 'keys.dpapi'), 'utf8');
    const fault = vi.mocked(fsSync.renameSync).mockImplementation(() => {
      throw Object.assign(new Error('fixture replacement failure'), { code: 'EACCES' });
    });
    expect(() => setSecret('FIXTURE_ROTATE', 'fake-new')).toThrow('fixture replacement failure');
    fault.mockRestore();
    expect(await fs.readFile(path.join(dir, 'keys.dpapi'), 'utf8')).toBe(original);
    expect(getSecret('FIXTURE_ROTATE')).toBe('fake-old');
    expect(await fs.readdir(dir)).toEqual(['keys.dpapi']);
  });

  it('removes its partial temporary file when writing the ciphertext fails', async () => {
    setSecret('FIXTURE_ROTATE', 'fake-old');
    const original = await fs.readFile(path.join(dir, 'keys.dpapi'), 'utf8');
    const realWrite = (await vi.importActual<typeof import('node:fs')>('node:fs')).writeFileSync;
    const fault = vi.mocked(fsSync.writeFileSync).mockImplementation((file, data, options) => {
      if (typeof data === 'string' && data.startsWith('AQAAANCM')) {
        realWrite(file, data.slice(0, 16), options);
        throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
      }
      return realWrite(file, data, options);
    });
    expect(() => setSecret('FIXTURE_ROTATE', 'fake-new')).toThrow('fixture disk full');
    fault.mockRestore();
    expect(await fs.readFile(path.join(dir, 'keys.dpapi'), 'utf8')).toBe(original);
    expect(getSecret('FIXTURE_ROTATE')).toBe('fake-old');
    expect(await fs.readdir(dir)).toEqual(['keys.dpapi']);
  });
});
