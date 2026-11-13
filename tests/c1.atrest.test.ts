// ─── 2.11: opt-in encryption at rest of backups and quarantine ──
//
// Off unless CRBRO_ENCRYPT_AT_REST=1. On, with the key in the keychain, a
// backup and a quarantine copy are sealed (AES-256-GCM) and still restore.
// On without the key, nothing is written in clear and nothing is deleted.
//
// The keychain is the real platform store; only Windows redirects it with
// CRBRO_KEYS_DIR, so the round trips that write a key run there alone. The
// crypto itself and the missing-key refusal run everywhere they safely can.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectBackend, setSecret } from '../src/engine/keychain.js';
import {
  seal, unseal, isSealed, generateAtRestKey, AtRestKeyError, AT_REST_KEY_NAME, _resetAtRestKeyCache,
} from '../src/engine/atrest.js';
import { BrainPaths, Brain } from '../src/engine/brain.js';
import { createBackup, readBackup, restoreBackup, listBackups } from '../src/engine/backup.js';
import { Cortex } from '../src/engine/cortex.js';
import { listQuarantine } from '../src/engine/quarantine.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const hasStore = detectBackend().backend !== null;
const windowsStore = process.platform === 'win32' && hasStore;

let root: string;
let brainDir: string;
let backupDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-c1-atrest-'));
  brainDir = path.join(root, 'brain');
  backupDir = path.join(root, 'backups');
  for (const k of ['CRBRO_KEYS_DIR', 'CRBRO_ENCRYPT_AT_REST', AT_REST_KEY_NAME]) saved[k] = process.env[k];
  process.env['CRBRO_KEYS_DIR'] = path.join(root, 'keys');
  delete process.env[AT_REST_KEY_NAME];
  _resetAtRestKeyCache();
  await fs.mkdir(path.join(brainDir, 'cortex'), { recursive: true });
  await fs.mkdir(path.join(brainDir, 'hippocampus'), { recursive: true });
  await fs.writeFile(path.join(brainDir, 'cortex', 'project_a.json'), JSON.stringify({ id: 'project_a', facts: [{ text: 'secreto de prueba' }] }));
  await fs.writeFile(path.join(brainDir, 'hippocampus', 'session_2026-11-01.json'), '{"summary":"x"}');
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  _resetAtRestKeyCache();
  await fs.rm(root, { recursive: true, force: true });
});

describe('the cipher', () => {
  it('round-trips with an explicit key, and refuses a wrong one', () => {
    const key = Buffer.from(generateAtRestKey(), 'base64');
    expect(key.length).toBe(32);
    const plano = Buffer.from('la ñ y el café ☕ sobreviven', 'utf8');
    const sellado = seal(plano, key);
    expect(isSealed(sellado)).toBe(true);
    expect(sellado.includes(plano)).toBe(false);
    expect(unseal(sellado, key).toString('utf8')).toBe(plano.toString('utf8'));
    expect(() => unseal(sellado, Buffer.alloc(32, 7))).toThrow(AtRestKeyError);
    // Clear data passes through untouched.
    expect(unseal(plano, key)).toEqual(plano);
  });
});

describe('switched on without a key', () => {
  it.runIf(windowsStore || !hasStore)('backup fails loudly, writes nothing and rotates nothing', async () => {
    const paths = new BrainPaths(brainDir);
    await createBackup(paths, { dir: backupDir, now: new Date('2026-11-01T10:00:00Z'), env: {} });
    const antes = await fs.readdir(backupDir);
    await expect(createBackup(paths, { dir: backupDir, keep: 1, env: { CRBRO_ENCRYPT_AT_REST: '1' } }))
      .rejects.toThrow(/CRBRO_ENCRYPT_AT_REST/);
    expect(await fs.readdir(backupDir)).toEqual(antes);
  });

  it.runIf(windowsStore || !hasStore)('forget refuses rather than keep a clear copy, and removes nothing', async () => {
    const brain = new Brain(path.join(root, 'b2'));
    await brain.initialize();
    const cortex = new Cortex(brain);
    await cortex.learn('Pruebas', 'fact', 'Una linea que se quiere olvidar.');
    process.env['CRBRO_ENCRYPT_AT_REST'] = '1';
    await expect(cortex.forget('project_pruebas', ['Una linea que se quiere olvidar.'])).rejects.toThrow(/CRBRO_ENCRYPT_AT_REST/);
    delete process.env['CRBRO_ENCRYPT_AT_REST'];
    const n = await cortex.peek('project_pruebas');
    expect(n!.facts.map(f => f.text)).toContain('Una linea que se quiere olvidar.');
    expect(await listQuarantine(brain.paths.quarantine)).toEqual([]);
  });
});

describe.runIf(windowsStore)('switched on with the key in the keychain', () => {
  beforeEach(() => {
    setSecret(AT_REST_KEY_NAME, generateAtRestKey(), 'crbro test - at-rest key');
    _resetAtRestKeyCache();
  });

  it('a backup is sealed, listed, read back and restored', async () => {
    const r = await createBackup(new BrainPaths(brainDir), { dir: backupDir, env: { CRBRO_ENCRYPT_AT_REST: '1' } });
    expect(r.file.endsWith('.json.gz.enc')).toBe(true);
    expect(r.verified).toBe(true);
    const bytes = await fs.readFile(r.path);
    expect(isSealed(bytes)).toBe(true);
    expect((await listBackups(backupDir))[0].encrypted).toBe(true);
    const b = await readBackup(r.path);
    expect(b.files['cortex/project_a.json']).toContain('secreto de prueba');
    const into = path.join(root, 'restaurado');
    await restoreBackup(r.path, into);
    expect(await fs.readFile(path.join(into, 'cortex', 'project_a.json'), 'utf8')).toContain('secreto de prueba');
  });

  it('a quarantine copy is sealed and restore opens it', async () => {
    const brain = new Brain(path.join(root, 'b3'));
    await brain.initialize();
    const cortex = new Cortex(brain);
    await cortex.learn('Claves', 'fact', 'El token viejo era de pruebas y se olvida.');
    await cortex.learn('Claves', 'fact', 'Esta linea se queda.');
    process.env['CRBRO_ENCRYPT_AT_REST'] = '1';
    const f = await cortex.forget('project_claves', ['El token viejo era de pruebas y se olvida.']);
    expect(f.removed).toBe(1);
    expect(f.backup!.endsWith('.entries.json.enc')).toBe(true);
    const crudo = await fs.readFile(f.backup!);
    expect(isSealed(crudo)).toBe(true);
    expect(crudo.toString('latin1')).not.toContain('token viejo');
    // Restore works whatever the switch says now.
    delete process.env['CRBRO_ENCRYPT_AT_REST'];
    const r = await cortex.restoreNeuron('project_claves');
    expect(r.merged_into_existing).toBe(true);
    const n = await cortex.peek('project_claves');
    expect(n!.facts.map(x => x.text)).toContain('El token viejo era de pruebas y se olvida.');
  });
});
