import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync, utimesSync,
} from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  autoInstallMod, installMod, uninstallMod, verifyMod, modPaths, modNoticeOnBoot, resetModOnBoot, takeModNotice,
  readModState, compareVersions, sha256, startModOnBoot, PLUGIN_DIRS_VAR, NOTICE_SESSIONS,
} from '../src/engine/modinstall.js';
import { configFingerprint } from '../src/daemon/endpoint.js';
import { cpSync } from 'node:fs';

/**
 * The automatic install crbro_boot runs once per process: the open-items band
 * reaches whoever has CRBRO and Claude Code without install-mod, says so once,
 * keeps itself up to date and stays out once it has been told to. Always
 * against a throwaway home folder, never the real ~/.claude.
 */
const PKG = join(__dirname, '..', 'mods', 'crbro-pending');
const BUILT_MOD = join(__dirname, '..', 'dist', 'engine', 'modinstall.js');
const VERSION = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version as string;

let home: string;
let paths: ReturnType<typeof modPaths>;
const ON = { CRBRO_MOD: '1' } as NodeJS.ProcessEnv;
const win = { platform: 'win32' as const };
const auto = (extra: Record<string, unknown> = {}) => autoInstallMod({ packageDir: PKG, home, env: ON, ...win, ...extra });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'crbro-automod-'));
  paths = modPaths(home);
  mkdirSync(paths.claudeDir, { recursive: true });
  resetModOnBoot();
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const settings = () => JSON.parse(readFileSync(paths.settingsPath, 'utf8'));
const writeSettings = (obj: unknown) => writeFileSync(paths.settingsPath, JSON.stringify(obj, null, 2));
const listed = () => String(settings().env?.[PLUGIN_DIRS_VAR] ?? '').split(';').filter(Boolean);

/** Every file under ~/.claude with its hash: proof that nothing was written. */
function snapshot(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) walk(p); else out.push(`${p}|${st.mtimeMs}|${sha256(readFileSync(p))}`);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort().join('\n');
}

function pluginAt(dir: string, name: string): string {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }));
  return dir;
}

describe('automatic install', () => {
  it('installs the first time, as install-mod would, and leaves one notice', async () => {
    writeSettings({ model: 'opus', env: { FOO: 'bar' }, hooks: { Stop: [] } });
    const r = await auto();
    expect(r.action).toBe('installed');
    expect(r.notice).toMatch(/installed its Claude Code mod "crbro-pending"/);
    expect(r.notice).toContain(`CRBRO ${VERSION}`);
    expect(r.notice).toMatch(/NEW Claude Code sessions/);
    expect(r.notice).toContain('npx crbro-memory uninstall-mod');
    expect(r.notice).toContain('CRBRO_MOD=0');
    expect(settings()).toEqual({ model: 'opus', env: { FOO: 'bar', [PLUGIN_DIRS_VAR]: paths.installedDir }, hooks: { Stop: [] } });
    expect(verifyMod({ packageDir: PKG, home, ...win }).ok).toBe(true);
    // No language is forced: auto, like install-mod without --lang.
    expect(settings().pluginConfigs).toBeUndefined();
    expect(readModState(home)).toMatchObject({ installed: true, version: VERSION });
    expect(existsSync(paths.lockPath)).toBe(false);
    // Said once: the notice is taken by one boot and is gone after.
    expect(takeModNotice(home)).toBe(r.notice);
    expect(takeModNotice(home)).toBeNull();
  });

  it('the second boot says nothing and writes nothing', async () => {
    await auto();
    takeModNotice(home);
    const before = snapshot(paths.claudeDir);
    const r = await auto();
    expect(r).toEqual({ action: 'current' });
    expect(snapshot(paths.claudeDir)).toBe(before);
    expect(takeModNotice(home)).toBeNull();
  });

  it('refreshes files that differ from the package, never settings.json, and says so once', async () => {
    writeSettings({ theme: 'dark' });
    await auto();
    takeModNotice(home);
    const settingsRaw = readFileSync(paths.settingsPath, 'utf8');
    const settingsMtime = statSync(paths.settingsPath).mtimeMs;
    // What an older version left: one file changed, one the package no longer has.
    writeFileSync(join(paths.installedDir, 'hooks', 'register.tsx'), '// an older band\n');
    writeFileSync(join(paths.installedDir, 'hooks', 'old.ts'), '// gone\n');

    const r = await auto();
    expect(r.action).toBe('updated');
    expect(r.notice).toMatch(/updated its Claude Code mod "crbro-pending"/);
    expect(r.notice).toMatch(/settings\.json was not touched/);
    expect(verifyMod({ packageDir: PKG, home, ...win }).ok).toBe(true);
    expect(existsSync(join(paths.installedDir, 'hooks', 'old.ts'))).toBe(false);
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe(settingsRaw);
    expect(statSync(paths.settingsPath).mtimeMs).toBe(settingsMtime);
    expect(takeModNotice(home)).toBe(r.notice);

    expect((await auto()).action).toBe('current');
    expect(takeModNotice(home)).toBeNull();
  });

  it('a copy left by a newer CRBRO is not taken back by an older one', async () => {
    await auto();
    takeModNotice(home);
    writeFileSync(join(paths.installedDir, 'hooks', 'register.tsx'), '// from a newer release\n');
    writeFileSync(paths.statePath, JSON.stringify({ installed: true, version: '99.0.0' }));
    const r = await auto();
    expect(r).toEqual({ action: 'skipped', reason: 'newer-installed' });
    expect(readFileSync(join(paths.installedDir, 'hooks', 'register.tsx'), 'utf8')).toBe('// from a newer release\n');
    expect(takeModNotice(home)).toBeNull();
    expect(compareVersions('2.8.0', '2.7.10')).toBe(1);
    expect(compareVersions('2.7.2', '2.7.2')).toBe(0);
  });

  it.each(['0', 'off', 'false', 'OFF', 'no'])('CRBRO_MOD=%s: nothing at all', async value => {
    writeSettings({ theme: 'dark' });
    const before = snapshot(paths.claudeDir);
    const r = await auto({ env: { CRBRO_MOD: value } });
    expect(r).toEqual({ action: 'skipped', reason: 'disabled' });
    expect(snapshot(paths.claudeDir)).toBe(before);
    expect(existsSync(paths.modsDir)).toBe(false);
  });

  it('respects the mark uninstall-mod leaves, and install-mod lifts it', async () => {
    await auto();
    takeModNotice(home);
    uninstallMod({ home, ...win });
    expect(readModState(home).optedOut).toBe(true);
    const before = snapshot(paths.claudeDir);
    expect(await auto()).toEqual({ action: 'skipped', reason: 'opted-out' });
    expect(snapshot(paths.claudeDir)).toBe(before);
    expect(existsSync(paths.installedDir)).toBe(false);
    expect(settings().env).toBeUndefined();

    installMod({ packageDir: PKG, home, ...win });
    expect(readModState(home).optedOut).toBeUndefined();
    expect(await auto()).toEqual({ action: 'current' });
  });

  it('uninstall-mod before any install still keeps it out', async () => {
    uninstallMod({ home, ...win });
    expect(await auto()).toEqual({ action: 'skipped', reason: 'opted-out' });
    expect(existsSync(paths.installedDir)).toBe(false);
  });

  it('a folder taken out of the list by hand counts as a no, stays out, and is said once', async () => {
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: 'C:\\plugins\\one' } });
    await auto();
    takeModNotice(home);
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: 'C:\\plugins\\one' } });
    const r = await auto();
    expect(r).toMatchObject({ action: 'skipped', reason: 'removed-by-hand' });
    // Not silent: the user hears that it will not come back, and how to bring it back.
    expect(r.notice).toMatch(/no longer in env\.CLAUDE_CODE_PLUGIN_DIRS/);
    expect(r.notice).toContain('npx crbro-memory install-mod brings it back');
    expect(takeModNotice(home)).toBe(r.notice);
    expect(readModState(home)).toMatchObject({ optedOut: true, optedOutBy: 'unlisted' });
    expect(settings().env[PLUGIN_DIRS_VAR]).toBe('C:\\plugins\\one');
    expect(await auto()).toEqual({ action: 'skipped', reason: 'opted-out' });
  });

  it('without ~/.claude it creates nothing', async () => {
    rmSync(paths.claudeDir, { recursive: true, force: true });
    expect(await auto()).toEqual({ action: 'skipped', reason: 'no-claude-code' });
    expect(existsSync(paths.claudeDir)).toBe(false);
    expect(await modNoticeOnBoot({ home, packageDir: PKG, env: ON, ...win })).toBeNull();
    expect(existsSync(paths.claudeDir)).toBe(false);
  });

  it('a package without the mod (the .mcpb bundle) is skipped', async () => {
    const r = await auto({ packageDir: join(home, 'nowhere') });
    expect(r).toEqual({ action: 'skipped', reason: 'not-in-package' });
    expect(existsSync(paths.modsDir)).toBe(false);
  });

  it('a settings.json that does not parse: untouched, nothing installed, not retried in a loop', async () => {
    writeFileSync(paths.settingsPath, '{ "env": { broken');
    const r = await auto();
    expect(r.action).toBe('failed');
    expect(r.reason).toMatch(/could not be parsed — not touching it/);
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe('{ "env": { broken');
    expect(existsSync(paths.installedDir)).toBe(false);
    expect(readModState(home).failed?.error).toMatch(/could not be parsed/);
    expect(existsSync(paths.lockPath)).toBe(false);

    // The same cause is not tried again at every start...
    expect(await auto()).toEqual({ action: 'skipped', reason: 'failed-before' });
    // ...but a day later it is, and still touches nothing.
    expect((await auto({ now: () => Date.now() + 25 * 3600 * 1000 })).action).toBe('failed');
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe('{ "env": { broken');
    // The boot never sees an error.
    rmSync(paths.statePath);
    await expect(modNoticeOnBoot({ home, packageDir: PKG, env: ON, ...win })).resolves.toBeNull();

    // Once settings.json is fixed, the next start installs.
    writeSettings({ theme: 'dark' });
    const fixed = await auto();
    expect(fixed.action).toBe('installed');
    expect(readModState(home).failed).toBeUndefined();
  });

  it('an env block that is not an object is refused like install-mod refuses it', async () => {
    writeSettings({ env: 'nope' });
    const r = await auto();
    expect(r.action).toBe('failed');
    expect(settings()).toEqual({ env: 'nope' });
  });

  it('replaces an earlier crbro-pendientes copy in the list, as install-mod does, and says so', async () => {
    const legacy = pluginAt(join(paths.claudeDir, 'mods', 'crbro-pendientes'), 'crbro-pendientes');
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: [legacy, 'C:\\plugins\\two'].join(';') } });
    const r = await auto();
    expect(r.action).toBe('installed');
    expect(listed()).toEqual([paths.installedDir, 'C:\\plugins\\two']);
    expect(existsSync(join(legacy, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(r.notice).toContain(`earlier copy "crbro-pendientes" (${legacy})`);
    // Named once, not again as "another copy".
    expect(r.notice).not.toContain(`Another copy is in ${legacy}`);
    // uninstall-mod puts it back.
    uninstallMod({ home, ...win });
    expect(listed()).toEqual([legacy, 'C:\\plugins\\two']);
  });

  it('never adds a second band beside another crbro-pending already listed', async () => {
    const checkout = pluginAt(join(home, 'src', 'crbro-pending'), 'crbro-pending');
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: checkout } });
    const before = snapshot(paths.claudeDir);
    expect(await auto()).toEqual({ action: 'skipped', reason: 'another-copy' });
    expect(settings().env[PLUGIN_DIRS_VAR]).toBe(checkout);
    expect(existsSync(paths.installedDir)).toBe(false);
    expect(snapshot(paths.claudeDir).split('\n').filter(l => l.includes('settings.json')))
      .toEqual(before.split('\n').filter(l => l.includes('settings.json')));
  });

  it('a fresh lock means another session is on it; a stale one is taken over', async () => {
    mkdirSync(paths.modsDir, { recursive: true });
    writeFileSync(paths.lockPath, '{}');
    expect(await auto()).toEqual({ action: 'skipped', reason: 'busy' });
    expect(existsSync(paths.settingsPath)).toBe(false);
    expect(existsSync(paths.lockPath)).toBe(true);

    const old = (Date.now() - 5 * 60_000) / 1000;
    utimesSync(paths.lockPath, old, old);
    expect((await auto()).action).toBe('installed');
    expect(existsSync(paths.lockPath)).toBe(false);
  });

  it('two at once in one process: one installs, settings.json stays valid with the path once', async () => {
    writeSettings({ model: 'opus', env: { FOO: 'bar', [PLUGIN_DIRS_VAR]: 'C:\\plugins\\one' } });
    const results = await Promise.all([auto(), auto(), auto()]);
    expect(results.filter(r => r.action === 'installed')).toHaveLength(1);
    for (const r of results) expect(['installed', 'busy', 'current']).toContain(r.action === 'skipped' ? r.reason : r.action);
    expect(settings()).toEqual({ model: 'opus', env: { FOO: 'bar', [PLUGIN_DIRS_VAR]: `C:\\plugins\\one;${paths.installedDir}` } });
    expect(takeModNotice(home)).toMatch(/installed/);
    expect(takeModNotice(home)).toBeNull();
  });

  it.skipIf(!existsSync(BUILT_MOD))('four processes at once: settings.json valid, every key kept, the path once', async () => {
    writeSettings({ model: 'opus', permissions: { allow: ['Bash(ls)'] }, env: { FOO: 'bar' } });
    const script = `require(${JSON.stringify(BUILT_MOD)}).autoInstallMod({ packageDir: ${JSON.stringify(PKG)}, ` +
      `home: ${JSON.stringify(home)}, env: { CRBRO_MOD: '1' } }).then(r => process.stdout.write(JSON.stringify(r)))`;
    const one = () => new Promise<string>((resolve, reject) => {
      const p = spawn(process.execPath, ['-e', script], { env: { ...process.env, CLAUDE_CODE_PLUGIN_DIRS: '' } });
      let out = '';
      p.stdout.on('data', d => { out += d; });
      p.on('error', reject);
      p.on('close', () => resolve(out));
    });
    const outs = (await Promise.all([one(), one(), one(), one()])).map(o => JSON.parse(o));
    expect(outs.filter(o => o.action === 'installed')).toHaveLength(1);
    for (const o of outs) expect(['installed', 'current', 'skipped']).toContain(o.action);
    for (const o of outs.filter(x => x.action === 'skipped')) expect(o.reason).toBe('busy');
    const s = settings();
    expect(s.model).toBe('opus');
    expect(s.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(s.env.FOO).toBe('bar');
    const sep = process.platform === 'win32' ? ';' : ':';
    expect(s.env[PLUGIN_DIRS_VAR].split(sep).filter((d: string) => d === paths.installedDir)).toHaveLength(1);
    expect(verifyMod({ packageDir: PKG, home }).ok).toBe(true);
    expect(readdirSync(paths.modsDir).filter(n => n.endsWith('.tmp') || n === 'auto.lock')).toEqual([]);
  }, 30_000);
});

describe('modNoticeOnBoot', () => {
  it('runs once per process and hands the notice over once, whether or not it made the budget', async () => {
    const first = await modNoticeOnBoot({ home, packageDir: PKG, env: ON, ...win, budgetMs: 0 });
    const second = await modNoticeOnBoot({ home, packageDir: PKG, env: ON, ...win, budgetMs: 10_000 });
    const said = [first, second].filter(Boolean);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/installed its Claude Code mod/);
    // Once per process: a changed file is not looked at again until the next process.
    writeFileSync(join(paths.installedDir, 'hooks', 'register.tsx'), '// changed\n');
    expect(await modNoticeOnBoot({ home, packageDir: PKG, env: ON, ...win })).toBeNull();
    resetModOnBoot();
    expect(await modNoticeOnBoot({ home, packageDir: PKG, env: ON, ...win })).toMatch(/updated its Claude Code mod/);
  });

  it('CRBRO_MOD=0 hands nothing over, not even a notice left before', async () => {
    await auto();
    expect(await modNoticeOnBoot({ home, packageDir: PKG, env: { CRBRO_MOD: '0' }, ...win })).toBeNull();
    expect(existsSync(paths.noticePath)).toBe(true);
  });
});

describe('after review', () => {
  it('CRBRO_MOD=0 is part of the daemon fingerprint: such a client is never served by a daemon without it', () => {
    expect(configFingerprint({})).toBe(configFingerprint({ CRBRO_MOD: '1' }));
    expect(configFingerprint({ CRBRO_MOD: '0' })).not.toBe(configFingerprint({}));
    expect(configFingerprint({ CRBRO_MOD: 'off' })).toBe(configFingerprint({ CRBRO_MOD: '0' }));
  });

  it('a plugin list only the environment holds is not hidden behind settings.json: skipped, and said once', async () => {
    writeSettings({ model: 'opus' });
    const before = readFileSync(paths.settingsPath, 'utf8');
    const r = await auto({ envDirs: 'C:\\plugins\\shell-only' });
    expect(r).toMatchObject({ action: 'skipped', reason: 'env-list' });
    expect(r.notice).toContain('C:\\plugins\\shell-only');
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe(before);
    expect(existsSync(paths.installedDir)).toBe(false);
    expect(takeModNotice(home)).toBe(r.notice);
    // Said once: the next start writes nothing and says nothing.
    const snap = snapshot(paths.claudeDir);
    expect(await auto({ envDirs: 'C:\\plugins\\shell-only' })).toEqual({ action: 'skipped', reason: 'env-list' });
    expect(snapshot(paths.claudeDir)).toBe(snap);
    // Moved into settings.json, the mod goes in beside it.
    writeSettings({ model: 'opus', env: { [PLUGIN_DIRS_VAR]: 'C:\\plugins\\shell-only' } });
    expect((await auto({ envDirs: 'C:\\plugins\\shell-only' })).action).toBe('installed');
    expect(listed()).toEqual(['C:\\plugins\\shell-only', paths.installedDir]);
  });

  it('an installed copy that differs only in line endings is current, not rewritten', async () => {
    await auto();
    takeModNotice(home);
    const file = join(paths.installedDir, 'hooks', 'register.tsx');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n'));
    const snap = snapshot(paths.claudeDir);
    expect(await auto()).toEqual({ action: 'current' });
    expect(snapshot(paths.claudeDir)).toBe(snap);
  });

  it('two builds of one version do not rewrite each other at every start', async () => {
    const other = join(home, 'other');
    const otherPkg = join(other, 'mods', 'crbro-pending');
    cpSync(PKG, otherPkg, { recursive: true });
    writeFileSync(join(other, 'package.json'), JSON.stringify({ version: VERSION }));
    writeFileSync(join(otherPkg, 'hooks', 'register.tsx'), readFileSync(join(PKG, 'hooks', 'register.tsx'), 'utf8') + '\n// a local build\n');
    expect((await auto()).action).toBe('installed');
    takeModNotice(home);
    const snap = snapshot(paths.claudeDir);
    expect(await auto({ packageDir: otherPkg })).toEqual({ action: 'skipped', reason: 'other-build' });
    expect(snapshot(paths.claudeDir)).toBe(snap);
    expect(await auto()).toEqual({ action: 'current' });
    expect(takeModNotice(home)).toBeNull();
    // A newer version does take over.
    writeFileSync(join(other, 'package.json'), JSON.stringify({ version: '99.0.0' }));
    expect((await auto({ packageDir: otherPkg })).action).toBe('updated');
    expect(compareVersions('2.8.0-beta.1', '2.8.0')).toBe(-1);
    expect(compareVersions('2.8.0', '2.8.0-beta.1')).toBe(1);
  });

  it('settings.json saved by someone else between read and write: their change is kept', async () => {
    writeSettings({ model: 'opus' });
    let once = false;
    const r = await auto({
      beforeSettingsWrite: () => {
        if (once) return;
        once = true;
        writeSettings({ model: 'sonnet', theme: 'dark' });
      },
    });
    expect(r.action).toBe('installed');
    expect(settings()).toEqual({ model: 'sonnet', theme: 'dark', env: { [PLUGIN_DIRS_VAR]: paths.installedDir } });
  });

  it('settings.json that keeps changing: nothing written, and not written down as a failure', async () => {
    writeSettings({ n: 0 });
    let n = 0;
    const r = await auto({ beforeSettingsWrite: () => writeSettings({ n: ++n }) });
    expect(r.action).toBe('failed');
    expect(settings().env).toBeUndefined();
    expect(existsSync(paths.installedDir)).toBe(false);
    expect(readModState(home).failed).toBeUndefined();
    expect((await auto()).action).toBe('installed');
  });

  it('uninstall-mod while the boot is installing: its mark wins', async () => {
    writeSettings({ model: 'opus' });
    const r = await auto({ beforeSettingsWrite: () => uninstallMod({ home, ...win }) });
    expect(r).toEqual({ action: 'skipped', reason: 'opted-out' });
    expect(settings()).toEqual({ model: 'opus' });
    expect(existsSync(paths.installedDir)).toBe(false);
    expect(readModState(home).optedOut).toBe(true);
  });

  it('a lock that changed hands is not removed by the process that lost it', async () => {
    writeSettings({});
    const theirs = JSON.stringify({ token: 'theirs' });
    const r = await auto({ beforeSettingsWrite: () => writeFileSync(paths.lockPath, theirs) });
    expect(r.action).toBe('installed');
    expect(readFileSync(paths.lockPath, 'utf8')).toBe(theirs);
  });

  it('keeps the CRLF line endings of a settings.json', async () => {
    writeFileSync(paths.settingsPath, '{\r\n  "model": "opus"\r\n}\r\n');
    await auto();
    const raw = readFileSync(paths.settingsPath, 'utf8');
    expect(raw).toContain('\r\n');
    expect(raw.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('a set-aside folder left by a run that died is cleaned up', async () => {
    const leftover = join(paths.modsDir, 'crbro-pending.4242.old');
    mkdirSync(leftover, { recursive: true });
    await auto();
    expect(existsSync(leftover)).toBe(false);
    expect(verifyMod({ packageDir: PKG, home, ...win }).ok).toBe(true);
  });

  it('uninstall-mod says so when it cannot leave its mark', () => {
    mkdirSync(paths.statePath, { recursive: true });
    const r = uninstallMod({ home, ...win });
    expect(r.markFailed).toBe(true);
    expect(r.lines.join('\n')).toMatch(/Could not write the opt-out mark/);
  });

  it('the notice goes to a few processes, once each, then is gone; a week-old one is not put back', async () => {
    const r = await auto();
    const heard: (string | null)[] = [];
    for (let i = 0; i < NOTICE_SESSIONS + 1; i++) {
      resetModOnBoot(); // a new process
      heard.push(takeModNotice(home));
      expect(takeModNotice(home)).toBeNull(); // the same process does not hear it twice
    }
    expect(heard.filter(Boolean)).toHaveLength(NOTICE_SESSIONS);
    expect(heard[NOTICE_SESSIONS]).toBeNull();
    expect(heard[0]).toBe(r.notice);

    resetModOnBoot();
    writeFileSync(join(paths.installedDir, 'hooks', 'register.tsx'), '// older\n');
    await auto();
    resetModOnBoot();
    expect(takeModNotice(home, () => Date.now() + 8 * 24 * 3600 * 1000)).toMatch(/updated/);
    resetModOnBoot();
    expect(takeModNotice(home)).toBeNull();
  });

  it('starting the boot does not take the notice: only a boot that answers does', async () => {
    startModOnBoot({ home, packageDir: PKG, env: ON, ...win, budgetMs: 10_000 }); // a boot that then fails
    const take = startModOnBoot({ home, packageDir: PKG, env: ON, ...win, budgetMs: 10_000 });
    expect(await take()).toMatch(/installed its Claude Code mod/);
  });
});

describe('crbro_boot', () => {
  let root: string;
  let bootHome: string;
  let client: Client;
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CRBRO_MOD: process.env.CRBRO_MOD, CRBRO_PATH: process.env.CRBRO_PATH };
  const boot = async () => JSON.parse(((await client.callTool({ name: 'crbro_boot', arguments: {} })) as any).content[0].text);

  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'crbro-automod-brain-'));
    bootHome = await fs.mkdtemp(join(tmpdir(), 'crbro-automod-home-'));
    await fs.mkdir(join(bootHome, '.claude'));
    await fs.writeFile(join(bootHome, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));
    process.env.CRBRO_PATH = root;
    process.env.HOME = bootHome;
    process.env.USERPROFILE = bootHome;
    process.env.CRBRO_MOD = '1';
    resetModOnBoot();
    const { createServer } = await import('../src/server.js');
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await createServer().connect(st);
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(ct);
  });

  afterAll(async () => {
    await client.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(bootHome, { recursive: true, force: true });
  });

  it('carries mod_notice the boot it installs, and not the next', async () => {
    const first = await boot();
    expect(first.mod_notice).toMatch(/installed its Claude Code mod "crbro-pending"/);
    expect(first.mod_notice).toMatch(/uninstall-mod/);
    const s = JSON.parse(readFileSync(join(bootHome, '.claude', 'settings.json'), 'utf8'));
    expect(s.model).toBe('opus');
    expect(s.env[PLUGIN_DIRS_VAR]).toBe(modPaths(bootHome).installedDir);

    const second = await boot();
    expect(second.mod_notice).toBeUndefined();
    expect(second.memory_discipline).toBeTruthy();
  });

  it('a later process that finds old files updates them and says so once', async () => {
    writeFileSync(join(modPaths(bootHome).installedDir, 'hooks', 'register.tsx'), '// older\n');
    resetModOnBoot();
    expect((await boot()).mod_notice).toMatch(/updated its Claude Code mod/);
    expect((await boot()).mod_notice).toBeUndefined();
  });
});
