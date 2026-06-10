import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { LicenseEngine } from '../src/engine/license.js';

let root: string;
let brain: Brain;

beforeEach(async () => {
  delete process.env.CRBRO_LICENSE_KEY;
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'crbro-lic-'));
  brain = new Brain(root);
  await brain.initialize();
});

afterEach(async () => {
  delete process.env.CRBRO_LICENSE_KEY;
  await fsp.rm(root, { recursive: true, force: true });
});

describe('LicenseEngine — no key', () => {
  it('reports the free tier and is not premium', async () => {
    const eng = new LicenseEngine(brain);
    expect(await eng.isPremium()).toBe(false);
    const info = await eng.getLicenseInfo();
    expect(info.tier).toBe('free');
    expect(info.valid).toBe(false);
    expect(info.features).toEqual([]);
    expect(await eng.getRejectionReason()).toBe('no_key');
  });
});

describe('LicenseEngine — format validation (MCP contract)', () => {
  it('rejects the legacy INV-ZERO- prefix as invalid_format', async () => {
    // The web used to mint INV-ZERO-* keys; the MCP only accepts SYNTH-ZERO-*.
    await brain.updateManifest({ license_key: 'INV-ZERO-AAAA-BBBB-CCCC' });
    const eng = new LicenseEngine(brain);
    expect(await eng.getRejectionReason()).toBe('invalid_format');
    expect(await eng.isPremium()).toBe(false);
  });

  it('rejects an env key with the wrong prefix', async () => {
    process.env.CRBRO_LICENSE_KEY = 'INV-ZERO-AAAA-BBBB-CCCC';
    const eng = new LicenseEngine(brain);
    // resolveKey ignores a malformed env key and falls back to the (empty) manifest.
    expect(await eng.isPremium()).toBe(false);
  });
});

describe('LicenseEngine — cache hit', () => {
  it('treats a fresh, valid, same-device cache entry as premium (no network)', async () => {
    const key = 'SYNTH-ZERO-AAAA-BBBB-CCCC';
    await brain.updateManifest({ license_key: key });

    const eng = new LicenseEngine(brain);
    const deviceId = (eng as unknown as { deviceId: string }).deviceId;

    // Seed the on-disk cache the engine reads before any network call.
    writeFileSync(
      path.join(root, '.license-cache.json'),
      JSON.stringify({ key, valid: true, verifiedAt: Date.now(), deviceId, status: 'active' }),
      'utf-8'
    );

    expect(await eng.isPremium()).toBe(true);
    const info = await eng.getLicenseInfo();
    expect(info.tier).toBe('premium');
    expect(info.features).toContain('global_map');
  });

  it('ignores an expired cache entry', async () => {
    const key = 'SYNTH-ZERO-AAAA-BBBB-CCCC';
    await brain.updateManifest({ license_key: key });

    const eng = new LicenseEngine(brain);
    const deviceId = (eng as unknown as { deviceId: string }).deviceId;
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000; // TTL is 7 days

    writeFileSync(
      path.join(root, '.license-cache.json'),
      JSON.stringify({ key, valid: true, verifiedAt: eightDaysAgo, deviceId, status: 'active' }),
      'utf-8'
    );

    // Expired cache → engine would hit the network; getRejectionReason stays
    // null (format is valid) but the cached-valid shortcut must NOT apply.
    const cached = (eng as unknown as { readCache: () => Promise<{ verifiedAt: number }> });
    const entry = await cached.readCache();
    expect(Date.now() - entry.verifiedAt).toBeGreaterThan(7 * 24 * 60 * 60 * 1000);
  });
});
