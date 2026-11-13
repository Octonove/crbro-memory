// 2.11 keychain: a missing store is never "empty", every write keeps sealed
// copies, removal is reversible, the daemon is not blocked, and the macOS and
// Linux paths no longer read a failure as an empty index. Every store here is a
// temporary CRBRO_KEYS_DIR with fake values; macOS and Linux run on stubs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  detectBackend, setSecret, getSecret, listSecrets, removeSecret,
  setSecretAsync, getSecretAsync, listSecretsAsync, removeSecretAsync,
  listSealedCopies, restoreSealedCopy, secretConfirmToken, KeychainMissing, KeychainUnavailable,
  _setKeychainRuntimeForTests, _resetKeychainMemoForTests,
  type KeychainCommand, type KeychainRunResult,
} from '../src/engine/keychain.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 });
const windowsStore = os.platform() === 'win32' && detectBackend().backend === 'windows-dpapi';
let dir: string;
const dbusBefore = process.env['DBUS_SESSION_BUS_ADDRESS'];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-keys-211-'));
  process.env['CRBRO_KEYS_DIR'] = dir;
  _resetKeychainMemoForTests();
});
afterEach(async () => {
  _setKeychainRuntimeForTests(null);
  delete process.env['CRBRO_KEYS_DIR'];
  delete process.env['CRBRO_KEYS_COPIES'];
  delete process.env['CRBRO_SECRET_FIXTURE_ENV'];
  if (dbusBefore === undefined) delete process.env['DBUS_SESSION_BUS_ADDRESS'];
  else process.env['DBUS_SESSION_BUS_ADDRESS'] = dbusBefore;
  await fs.rm(dir, { recursive: true, force: true });
});

const copies = () => listSealedCopies().filter(c => c.kind === 'sealed-copy');

describe.runIf(windowsStore)('Windows store: missing is not empty (G4)', () => {
  it('a store that vanished after writes is reported with recovery hints', async () => {
    setSecret('FIXTURE_A', 'fake-a');
    await fs.unlink(path.join(dir, 'keys.dpapi'));
    _resetKeychainMemoForTests();
    expect(() => listSecrets()).toThrow(KeychainMissing);
    expect(() => getSecret('FIXTURE_A')).toThrow(/secret restore/);
    expect(() => setSecret('FIXTURE_B', 'fake-b')).toThrow(KeychainMissing);
    await expect(listSecretsAsync()).rejects.toBeInstanceOf(KeychainMissing);
    // Nothing was created in its place.
    expect((await fs.readdir(dir)).includes('keys.dpapi')).toBe(false);
  });

  it('the marker alone is enough evidence', async () => {
    await fs.writeFile(path.join(dir, 'keys.dpapi.marker'), '{"v":1}');
    expect(() => listSecrets()).toThrow(KeychainMissing);
  });

  it('first use on a clean directory is still an empty store', () => {
    expect(listSecrets()).toEqual([]);
    setSecret('FIXTURE_A', 'fake-a');
    expect(getSecret('FIXTURE_A')).toBe('fake-a');
  });

  it('set --force starts an empty store on purpose; the copies stay', async () => {
    setSecret('FIXTURE_A', 'fake-a');
    await fs.unlink(path.join(dir, 'keys.dpapi'));
    setSecret('FIXTURE_B', 'fake-b', '', { force: true });
    expect(listSecrets().map(e => e.name)).toEqual(['FIXTURE_B']);
    expect(copies().length).toBeGreaterThanOrEqual(2);
  });

  it('restore puts the newest sealed copy back after the file vanished', async () => {
    setSecret('FIXTURE_A', 'fake-a');
    setSecret('FIXTURE_B', 'fake-b');
    await fs.unlink(path.join(dir, 'keys.dpapi'));
    const newest = copies()[0];
    const r = restoreSealedCopy(newest.id);
    expect(r.entries).toBe(2);
    expect(getSecret('FIXTURE_B')).toBe('fake-b');
  });

  it('a leftover temporary can be restored after being validated', async () => {
    setSecret('FIXTURE_A', 'fake-a');
    const sealed = await fs.readFile(path.join(dir, 'keys.dpapi'), 'utf8');
    await fs.rm(path.join(dir, 'sealed-copies'), { recursive: true });
    await fs.rm(path.join(dir, 'keys.dpapi.marker'));
    await fs.rename(path.join(dir, 'keys.dpapi'), path.join(dir, 'keys.dpapi.tmp'));
    expect(() => listSecrets()).toThrow(KeychainMissing);
    expect(listSealedCopies().map(c => [c.id, c.kind])).toEqual([['keys.dpapi.tmp', 'temporary']]);
    restoreSealedCopy('keys.dpapi.tmp');
    expect(getSecret('FIXTURE_A')).toBe('fake-a');
    expect((await fs.readFile(path.join(dir, 'keys.dpapi'), 'utf8')).trim()).toBe(sealed.trim());
  });

  it('refuses to restore something that does not open', async () => {
    setSecret('FIXTURE_A', 'fake-a');
    const before = await fs.readFile(path.join(dir, 'keys.dpapi'), 'utf8');
    await fs.writeFile(path.join(dir, 'keys.dpapi.bak-manual'), 'not-a-sealed-store');
    expect(() => restoreSealedCopy('keys.dpapi.bak-manual')).toThrow(KeychainUnavailable);
    expect(() => restoreSealedCopy('../keys.dpapi')).toThrow(/Invalid copy id/);
    expect(await fs.readFile(path.join(dir, 'keys.dpapi'), 'utf8')).toBe(before);
  });
});

describe.runIf(windowsStore)('Windows store: sealed copies (G4, G6)', () => {
  it('keeps byte copies of the sealed file, never plaintext, and rotates them', async () => {
    process.env['CRBRO_KEYS_COPIES'] = '3';
    for (const v of ['one', 'two', 'three', 'four', 'five']) setSecret('FIXTURE_ROT', `fake-${v}`);
    const kept = copies();
    expect(kept.length).toBe(3);
    for (const c of kept) {
      const raw = await fs.readFile(path.join(dir, 'sealed-copies', c.id), 'utf8');
      expect(raw.trim()).toMatch(/^AQAAANCM/);
      expect(raw).not.toContain('fake-');
    }
    // The newest copy is the current store.
    expect((await fs.readFile(path.join(dir, 'sealed-copies', kept[0].id), 'utf8')).trim())
      .toBe((await fs.readFile(path.join(dir, 'keys.dpapi'), 'utf8')).trim());
  });

  it('a removal can be undone from the copy taken before it', () => {
    setSecret('FIXTURE_KEEP', 'fake-keep');
    setSecret('FIXTURE_DROP', 'fake-drop');
    expect(removeSecret('FIXTURE_DROP')).toBe(true);
    expect(getSecret('FIXTURE_DROP')).toBeNull();
    const beforeRemoval = copies()[1];
    restoreSealedCopy(beforeRemoval.id);
    expect(getSecret('FIXTURE_DROP')).toBe('fake-drop');
    expect(getSecret('FIXTURE_KEEP')).toBe('fake-keep');
  });

  it('sweeps its own stale temporaries but never the legacy fixed name', async () => {
    setSecret('FIXTURE_A', 'fake-a');
    const stale = path.join(dir, `keys.dpapi.4242.${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}.tmp`);
    const legacy = path.join(dir, 'keys.dpapi.tmp');
    await fs.writeFile(stale, 'x');
    await fs.writeFile(legacy, 'y');
    const old = new Date(Date.now() - 2 * 3600_000);
    await fs.utimes(stale, old, old);
    await fs.utimes(legacy, old, old);
    setSecret('FIXTURE_B', 'fake-b');
    const names = await fs.readdir(dir);
    expect(names).not.toContain(path.basename(stale));
    expect(names).toContain('keys.dpapi.tmp');
  });
});

describe.runIf(windowsStore)('async API for the daemon (G15)', () => {
  it('round-trips and says where the value came from', async () => {
    await setSecretAsync('FIXTURE_ASYNC', 'fake-async', 'async test');
    expect(await getSecretAsync('FIXTURE_ASYNC')).toEqual({ value: 'fake-async', source: 'keychain' });
    expect((await listSecretsAsync()).map(e => e.name)).toEqual(['FIXTURE_ASYNC']);
    process.env['CRBRO_SECRET_FIXTURE_ENV'] = 'fake-env';
    expect(await getSecretAsync('FIXTURE_ENV')).toEqual({ value: 'fake-env', source: 'env' });
    expect(await removeSecretAsync('FIXTURE_ASYNC')).toBe(true);
    expect(await getSecretAsync('FIXTURE_ASYNC')).toBeNull();
  });

  it('does not block the event loop while PowerShell runs', async () => {
    await setSecretAsync('FIXTURE_ASYNC', 'fake-async');
    _resetKeychainMemoForTests();          // cold: probe + DPAPI open
    let ticks = 0;
    const t = setInterval(() => { ticks++; }, 10);
    const started = Date.now();
    await getSecretAsync('FIXTURE_ASYNC');
    const took = Date.now() - started;
    clearInterval(t);
    // A blocked loop would tick zero times during the whole call.
    expect(ticks).toBeGreaterThan(Math.min(3, Math.floor(took / 40)));
  });

  it('memoises the probe', () => {
    detectBackend();
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) detectBackend();
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('confirmation tokens are bound to the store state and the value', async () => {
    await setSecretAsync('FIXTURE_TOK', 'fake-1');
    const a = await secretConfirmToken('set', 'FIXTURE_TOK', 'fake-2');
    expect(await secretConfirmToken('set', 'FIXTURE_TOK', 'fake-2')).toBe(a);
    expect(await secretConfirmToken('set', 'FIXTURE_TOK', 'fake-3')).not.toBe(a);
    expect(await secretConfirmToken('remove', 'FIXTURE_TOK')).not.toBe(a);
    await setSecretAsync('FIXTURE_OTHER', 'fake-o');
    expect(await secretConfirmToken('set', 'FIXTURE_TOK', 'fake-2')).not.toBe(a);
  });
});

// ─── macOS and Linux on stubs ────────────────────────────────────

type Handler = (c: KeychainCommand) => KeychainRunResult | undefined;
function stub(platform: NodeJS.Platform, handler: Handler) {
  const calls: KeychainCommand[] = [];
  _setKeychainRuntimeForTests({
    platform,
    sync: c => {
      calls.push(c);
      const ok = (stdout = ''): KeychainRunResult => ({ status: 0, stdout, stderr: '' });
      if (c.args[0] === '-h' || c.args[0] === '--help') return ok();
      return handler(c) ?? ok();
    },
  });
  return calls;
}
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('macOS: a failure is never an empty index (G11)', () => {
  it('set refuses when the index cannot be read, and writes nothing', () => {
    const calls = stub('darwin', c =>
      c.args.includes('__crbro_index__') && c.args[0] === 'find-generic-password'
        ? { status: 51, stdout: '', stderr: 'denied' } : undefined);
    expect(() => setSecret('FIXTURE_A', 'fake-a')).toThrow(/index/);
    expect(calls.some(c => c.args[0] === 'add-generic-password')).toBe(false);
  });

  it('a missing index (44) is empty; the new name is added to it', () => {
    let written = '';
    stub('darwin', c => {
      if (c.args[0] === 'find-generic-password') return { status: 44, stdout: '', stderr: '' };
      if (c.args[0] === 'add-generic-password' && c.args.includes('__crbro_index__')) {
        written = Buffer.from(c.args[c.args.indexOf('-w') + 1], 'base64').toString('utf8');
      }
      return undefined;
    });
    setSecret('FIXTURE_A', 'fake-a', 'desc');
    expect(Object.keys(JSON.parse(written))).toEqual(['FIXTURE_A']);
  });

  it('a failed index write is an error, not a silent success', () => {
    stub('darwin', c => {
      if (c.args[0] === 'find-generic-password') return { status: 0, stdout: b64('{}') + '\n', stderr: '' };
      if (c.args[0] === 'add-generic-password' && c.args.includes('__crbro_index__')) return { status: 1, stdout: '', stderr: 'nope' };
      return undefined;
    });
    expect(() => setSecret('FIXTURE_A', 'fake-a')).toThrow(/name index/);
  });

  it('get: 44 is "not found", any other failure throws', () => {
    stub('darwin', c => (c.args.includes('FIXTURE_NONE') ? { status: 44, stdout: '', stderr: '' }
      : c.args.includes('FIXTURE_DENIED') ? { status: 51, stdout: '', stderr: 'denied' } : undefined));
    expect(getSecret('FIXTURE_NONE')).toBeNull();
    expect(() => getSecret('FIXTURE_DENIED')).toThrow(KeychainUnavailable);
  });

  it('an unreadable index is refused instead of rewritten', () => {
    stub('darwin', c => (c.args[0] === 'find-generic-password' ? { status: 0, stdout: b64('{trunc') + '\n', stderr: '' } : undefined));
    expect(() => listSecrets()).toThrow(/Refusing to rewrite/);
  });
});

describe('Linux: names without pulling values (G12)', () => {
  it('lists from the index item, never with search --all, and reads descriptions', () => {
    const calls = stub('linux', c => (c.args[0] === 'lookup' && c.args.includes('__crbro_index__')
      ? { status: 0, stdout: JSON.stringify({ FIXTURE_A: { description: 'svc a', updated: '2026-11-13' } }), stderr: '' }
      : undefined));
    process.env['DBUS_SESSION_BUS_ADDRESS'] ||= 'unix:path=/fixture';
    expect(listSecrets()).toEqual([{ name: 'FIXTURE_A', description: 'svc a', updated: '2026-11-13' }]);
    expect(calls.some(c => c.args.includes('--all'))).toBe(false);
  });

  it('migrates a 2.10 store once, keeping names and descriptions only', () => {
    let index = '';
    stub('linux', c => {
      if (c.args[0] === 'lookup') return { status: 1, stdout: '', stderr: '' };
      if (c.args[0] === 'search') {
        return { status: 0, stderr: '', stdout:
          '[/1]\nlabel = CRBRO FIXTURE_A\nsecret = fake-value-a\nattribute.account = FIXTURE_A\nattribute.description = svc a\n' +
          '[/2]\nlabel = CRBRO FIXTURE_B\nsecret = fake-value-b\nattribute.account = FIXTURE_B\nattribute.description = \n' };
      }
      if (c.args[0] === 'store' && c.args.includes('__crbro_index__')) index = c.input || '';
      return undefined;
    });
    process.env['DBUS_SESSION_BUS_ADDRESS'] ||= 'unix:path=/fixture';
    setSecret('FIXTURE_C', 'fake-c', 'svc c');
    expect(index).not.toContain('fake-value');
    expect(Object.keys(JSON.parse(index)).sort()).toEqual(['FIXTURE_A', 'FIXTURE_B', 'FIXTURE_C']);
    expect(JSON.parse(index).FIXTURE_A.description).toBe('svc a');
  });

  it('a failing secret-tool is an error, not an empty list', () => {
    stub('linux', c => (c.args[0] === 'lookup' ? { status: 1, stdout: '', stderr: 'dbus error' } : undefined));
    process.env['DBUS_SESSION_BUS_ADDRESS'] ||= 'unix:path=/fixture';
    expect(() => listSecrets()).toThrow(KeychainUnavailable);
  });

  it('the value goes through stdin, never argv', () => {
    const calls = stub('linux', c => (c.args[0] === 'lookup' ? { status: 1, stdout: '', stderr: '' }
      : c.args[0] === 'search' ? { status: 1, stdout: '', stderr: '' } : undefined));
    process.env['DBUS_SESSION_BUS_ADDRESS'] ||= 'unix:path=/fixture';
    setSecret('FIXTURE_A', 'fake-stdin-only');
    const store = calls.find(c => c.args[0] === 'store' && c.args.includes('FIXTURE_A'))!;
    expect(store.args.join(' ')).not.toContain('fake-stdin-only');
    expect(store.input).toBe('fake-stdin-only');
  });
});
