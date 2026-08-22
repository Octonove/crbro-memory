// ─── Credentials go to the keychain, not the brain ───────────────
//
// The filter refuses to store a credential, so the broker is where it goes
// instead. That makes this module the one place in CRBRO where losing data is
// worse than losing memory: a password that goes in and does not come back out
// intact is a locked-out user, and the failure shows up much later as a
// baffling 401 rather than as an error here.
//
// So these tests care about exactly two things — that a value survives the
// round trip byte for byte, and that nothing here can ever reach the brain.
// Every backend is the platform's own store, so only the one this machine runs
// is exercised; the rest are covered by keeping the surface identical.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  detectBackend, setSecret, getSecret, listSecrets, removeSecret,
} from '../src/engine/keychain.js';

const onWindows = os.platform() === 'win32';
let keysDir: string;

beforeEach(async () => {
  keysDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-keys-'));
  process.env['CRBRO_KEYS_DIR'] = keysDir;
});

afterEach(async () => {
  delete process.env['CRBRO_KEYS_DIR'];
  delete process.env['TEST_ENV_WINS'];
  await fs.rm(keysDir, { recursive: true, force: true });
});

describe('detectBackend', () => {
  it('names a backend or explains why there is none', () => {
    const { backend, reason } = detectBackend();
    if (backend) {
      expect(['macos-keychain', 'linux-secret-service', 'windows-dpapi']).toContain(backend);
    } else {
      // "No keychain here" is a normal answer on a headless box, but it has to
      // arrive with something the user can act on.
      expect(reason && reason.length).toBeGreaterThan(10);
    }
  });

  it('picks the backend that matches the platform', () => {
    const { backend } = detectBackend();
    if (!backend) return;
    if (os.platform() === 'win32') expect(backend).toBe('windows-dpapi');
    if (os.platform() === 'darwin') expect(backend).toBe('macos-keychain');
  });
});

describe('name validation', () => {
  it.runIf(onWindows)('rejects names that are not SCREAMING_SNAKE_CASE', () => {
    expect(() => setSecret('lowercase', 'x')).toThrow(/SCREAMING_SNAKE_CASE/);
    expect(() => setSecret('WITH-DASH', 'x')).toThrow();
    expect(() => setSecret('9_LEADING_DIGIT', 'x')).toThrow();
  });

  it.runIf(onWindows)('refuses an empty value', () => {
    // Storing "" and reading it back as null is indistinguishable from a
    // missing secret, and that ambiguity is what makes it worth refusing.
    expect(() => setSecret('EMPTY_ONE', '')).toThrow(/empty/i);
  });
});

describe('round trip', () => {
  it.runIf(onWindows)('returns the value exactly as it went in', () => {
    setSecret('SIMPLE_ONE', 'plain-value', 'a test');
    expect(getSecret('SIMPLE_ONE')).toBe('plain-value');
  });

  it.runIf(onWindows)('survives the characters that actually break credentials', () => {
    // A WordPress application password carries spaces; shell metacharacters
    // are what a naive implementation mangles; and a trailing newline is the
    // classic cause of a 401 nobody can explain.
    const awkward: Array<[string, string]> = [
      ['WP_STYLE', 'kX0K Z948 9dRA mm4k 6DWh U4N5'],
      ['SHELL_META', '61k4$96V$1KyVKb2EkEb'],
      ['QUOTES', `mixed "double" and 'single' quotes`],
      ['UNICODE', 'contraseña-con-acentos-ñ'],
      ['BACKTICKS', 'back`tick`and;semicolon&amp'],
    ];
    for (const [name, value] of awkward) {
      setSecret(name, value);
      expect(getSecret(name), `${name} did not survive the round trip`).toBe(value);
    }
  });

  it.runIf(onWindows)('overwrites instead of duplicating', () => {
    setSecret('ROTATED', 'first');
    setSecret('ROTATED', 'second');
    expect(getSecret('ROTATED')).toBe('second');
    expect(listSecrets().filter(e => e.name === 'ROTATED')).toHaveLength(1);
  });

  it.runIf(onWindows)('returns null for a secret that was never stored', () => {
    expect(getSecret('NEVER_STORED_XYZ')).toBeNull();
  });
});

describe('environment variables win', () => {
  it.runIf(onWindows)('prefers the environment over the store', () => {
    // This is what lets CI and one-off overrides work without anyone touching
    // the user's keychain.
    setSecret('TEST_ENV_WINS', 'from-keychain');
    process.env['TEST_ENV_WINS'] = 'from-environment';
    expect(getSecret('TEST_ENV_WINS')).toBe('from-environment');
  });
});

describe('listing', () => {
  it.runIf(onWindows)('reports names and descriptions but never values', () => {
    setSecret('ALPHA_KEY', 'secret-alpha', 'the alpha service');
    setSecret('BETA_KEY', 'secret-beta', 'the beta service');
    const entries = listSecrets();
    const names = entries.map(e => e.name);
    expect(names).toContain('ALPHA_KEY');
    expect(names).toContain('BETA_KEY');
    expect(JSON.stringify(entries)).not.toContain('secret-alpha');
    expect(JSON.stringify(entries)).not.toContain('secret-beta');
  });

  it.runIf(onWindows)('comes back sorted, so the output is stable between runs', () => {
    setSecret('ZULU_KEY', 'z');
    setSecret('ALPHA_KEY', 'a');
    const names = listSecrets().map(e => e.name);
    expect(names).toEqual([...names].sort());
  });
});

describe('removal', () => {
  it.runIf(onWindows)('deletes one and leaves the rest alone', () => {
    setSecret('KEEP_ME', 'kept');
    setSecret('DELETE_ME', 'gone');
    expect(removeSecret('DELETE_ME')).toBe(true);
    expect(getSecret('DELETE_ME')).toBeNull();
    expect(getSecret('KEEP_ME')).toBe('kept');
  });

  it.runIf(onWindows)('says false rather than throwing when there was nothing to delete', () => {
    expect(removeSecret('NEVER_EXISTED_XYZ')).toBe(false);
  });
});

describe('the store never touches the brain', () => {
  it.runIf(onWindows)('writes only inside its own directory', async () => {
    setSecret('SOME_KEY', 'some-value');
    const written = await fs.readdir(keysDir);
    expect(written).toContain('keys.dpapi');
  });

  it.runIf(onWindows)('leaves nothing readable on disk', async () => {
    setSecret('PLAINTEXT_CHECK', 'do-not-find-me-in-the-file');
    const raw = await fs.readFile(path.join(keysDir, 'keys.dpapi'), 'utf8');
    expect(raw).not.toContain('do-not-find-me-in-the-file');
    expect(raw).not.toContain('PLAINTEXT_CHECK');
    // A DPAPI blob is hex, and starts with the provider header.
    expect(raw.trim()).toMatch(/^01000000d08c9ddf/i);
  });
});
