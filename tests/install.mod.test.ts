import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync, lstatSync, chmodSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  installMod, uninstallMod, verifyMod, formatModVerify, modFiles, modPaths, sha256, PLUGIN_DIRS_VAR,
} from '../src/engine/modinstall.js';

/**
 * `install-mod`, `uninstall-mod` and `install-mod --verify`: the Claude Code
 * mod copied to ~/.claude/crbro-mods/crbro-pending and listed in
 * env.CLAUDE_CODE_PLUGIN_DIRS. Always against a throwaway home folder, never
 * the real ~/.claude.
 */
const PKG = join(__dirname, '..', 'mods', 'crbro-pending');
const CLI = join(__dirname, '..', 'bin', 'crbro.mjs');
const BUILT = existsSync(join(__dirname, '..', 'dist', 'engine', 'modinstall.js'));

let home: string;
let paths: ReturnType<typeof modPaths>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'crbro-mod-'));
  paths = modPaths(home);
  mkdirSync(paths.claudeDir, { recursive: true });
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const settings = () => JSON.parse(readFileSync(paths.settingsPath, 'utf8'));
const writeSettings = (obj: unknown) => writeFileSync(paths.settingsPath, JSON.stringify(obj, null, 2));
const win = { platform: 'win32' as const };

/** A folder holding a plugin of that name, as an earlier local copy would. */
function pluginAt(dir: string, name: string): string {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }));
  return dir;
}

/** Every file under a folder with its size and hash, to prove nothing else moved. */
function snapshot(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) walk(p); else out.push(`${p}|${st.size}|${sha256(readFileSync(p))}`);
    }
  };
  walk(dir);
  return out.sort().join('\n');
}

describe('the mod in the package', () => {
  it('ships its manifest, hooks module and types, never its tests', () => {
    const files = modFiles(PKG);
    expect(files).toEqual(expect.arrayContaining([
      '.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.tsx', 'hooks/strings.ts', 'types/index.d.ts',
    ]));
    expect(files.some(f => f.startsWith('test/') || f === 'tsconfig.json' || f.startsWith('.claude-plugin/types/'))).toBe(false);
    expect(JSON.parse(readFileSync(join(PKG, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('crbro-pending');
    // npm leaves out what the install leaves out.
    const ignore = readFileSync(join(PKG, '.npmignore'), 'utf8');
    for (const line of ['test/', 'tsconfig.json', '.claude-plugin/types/']) expect(ignore).toContain(line);
  });
});

describe('install-mod', () => {
  it('installs with no settings.json: copies the mod and lists its folder', () => {
    const r = installMod({ packageDir: PKG, home, ...win });
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(settings()).toEqual({ env: { [PLUGIN_DIRS_VAR]: paths.installedDir } });
    expect(modFiles(paths.installedDir)).toEqual(modFiles(PKG));
    expect(existsSync(join(paths.installedDir, 'test'))).toBe(false);
    expect(r.lines.join('\n')).toMatch(/2\.1\.286/);
    expect(r.lines.join('\n')).toMatch(/new session/);
  });

  it('installs into an empty settings object', () => {
    writeFileSync(paths.settingsPath, '{}');
    expect(installMod({ packageDir: PKG, home, ...win }).ok).toBe(true);
    expect(settings().env[PLUGIN_DIRS_VAR]).toBe(paths.installedDir);
  });

  it('appends to an existing list and touches nothing else', () => {
    const before = {
      model: 'opus',
      env: { FOO: 'bar', [PLUGIN_DIRS_VAR]: 'C:\\plugins\\one;C:\\plugins\\two' },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo not ours' }] }] },
      pluginConfigs: { other: { options: { a: 1 } } },
    };
    writeSettings(before);
    installMod({ packageDir: PKG, home, ...win });
    const after = settings();
    expect(after.env[PLUGIN_DIRS_VAR]).toBe(`C:\\plugins\\one;C:\\plugins\\two;${paths.installedDir}`);
    expect({ ...after, env: { ...after.env, [PLUGIN_DIRS_VAR]: undefined } })
      .toEqual({ ...before, env: { ...before.env, [PLUGIN_DIRS_VAR]: undefined } });
  });

  it('uses ":" outside Windows and ";" on Windows', () => {
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: '/opt/plugins/one:/opt/plugins/two' } });
    installMod({ packageDir: PKG, home, platform: 'linux' });
    expect(settings().env[PLUGIN_DIRS_VAR]).toBe(`/opt/plugins/one:/opt/plugins/two:${paths.installedDir}`);

    writeSettings({ env: { [PLUGIN_DIRS_VAR]: 'D:\\one;D:\\two' } });
    installMod({ packageDir: PKG, home, platform: 'win32' });
    expect(settings().env[PLUGIN_DIRS_VAR]).toBe(`D:\\one;D:\\two;${paths.installedDir}`);
  });

  it('reads a settings.json with a BOM and writes it back without one', () => {
    writeFileSync(paths.settingsPath, '\uFEFF' + JSON.stringify({ theme: 'dark' }));
    const r = installMod({ packageDir: PKG, home, ...win });
    expect(r.ok).toBe(true);
    const raw = readFileSync(paths.settingsPath, 'utf8');
    expect(raw.charCodeAt(0)).not.toBe(0xfeff);
    expect(JSON.parse(raw)).toEqual({ theme: 'dark', env: { [PLUGIN_DIRS_VAR]: paths.installedDir } });
  });

  it('leaves a settings.json that does not parse exactly as it was, and installs nothing', () => {
    writeFileSync(paths.settingsPath, '{ "env": { broken');
    const r = installMod({ packageDir: PKG, home, ...win });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not be parsed — not touching it/);
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe('{ "env": { broken');
    expect(existsSync(paths.installedDir)).toBe(false);
  });

  it('refuses a list that is not a string', () => {
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: ['a', 'b'] } });
    const r = installMod({ packageDir: PKG, home, ...win });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/is not a string/);
  });

  it('is idempotent: the second run writes nothing and lists the folder once', () => {
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: 'C:\\plugins\\one' } });
    installMod({ packageDir: PKG, home, ...win });
    const first = readFileSync(paths.settingsPath, 'utf8');
    const r = installMod({ packageDir: PKG, home, ...win });
    expect(r.changed).toBe(false);
    expect(r.alreadyListed).toBe(true);
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe(first);
    expect(settings().env[PLUGIN_DIRS_VAR].split(';')).toHaveLength(2);
    expect(r.lines.join('\n')).toMatch(/Already in CLAUDE_CODE_PLUGIN_DIRS/);
  });

  it('recognises its folder however it is spelt (slashes, case, trailing slash, ~)', () => {
    const spelt = paths.installedDir.split('\\').join('/').toUpperCase() + '/';
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: spelt } });
    const r = installMod({ packageDir: PKG, home, ...win });
    expect(r.alreadyListed).toBe(true);
    expect(r.changed).toBe(false);

    writeSettings({ env: { [PLUGIN_DIRS_VAR]: '~/.claude/crbro-mods/crbro-pending' } });
    expect(installMod({ packageDir: PKG, home, platform: 'linux' }).alreadyListed).toBe(true);
  });

  it('replaces an earlier crbro-pendientes copy in place, says so and keeps its folder', () => {
    const legacy = pluginAt(join(home, 'my-mods', 'crbro-pendientes'), 'crbro-pendientes');
    const other = pluginAt(join(home, 'my-mods', 'something-else'), 'something-else');
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: [other, legacy, 'C:\\plugins\\last'].join(';') } });
    const r = installMod({ packageDir: PKG, home, ...win });
    expect(r.replaced).toEqual([{ dir: legacy, name: 'crbro-pendientes' }]);
    expect(settings().env[PLUGIN_DIRS_VAR]).toBe([other, paths.installedDir, 'C:\\plugins\\last'].join(';'));
    expect(existsSync(join(legacy, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(r.lines.join('\n')).toMatch(/Replaced your earlier copy "crbro-pendientes"/);
  });

  it('warns about a copy in ~/.claude/mods and leaves it alone', () => {
    const local = pluginAt(join(paths.claudeDir, 'mods', 'crbro-pendientes'), 'crbro-pendientes');
    pluginAt(join(paths.claudeDir, 'mods', 'unrelated'), 'unrelated');
    const before = snapshot(join(paths.claudeDir, 'mods'));
    const r = installMod({ packageDir: PKG, home, ...win });
    expect(r.elsewhere).toEqual([local]);
    expect(r.lines.join('\n')).toContain(`Another copy is in ${local}`);
    expect(snapshot(join(paths.claudeDir, 'mods'))).toBe(before);
  });

  it('keeps another crbro-pending folder (a checkout), points it out, and never lists itself twice', () => {
    const checkout = pluginAt(join(home, 'src', 'crbro-memory', 'mods', 'crbro-pending'), 'crbro-pending');
    const list = [paths.installedDir, checkout].join(';');
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: list } });
    const r = installMod({ packageDir: PKG, home, ...win });
    expect(r.replaced).toEqual([]);
    expect(r.elsewhere).toEqual([checkout]);
    expect(r.changed).toBe(false);
    expect(settings().env[PLUGIN_DIRS_VAR]).toBe(list);
    expect(r.lines.join('\n')).toContain(`Another copy is in ${checkout}`);
  });

  it('recognises its folder written between quotes', () => {
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: `"${paths.installedDir}";C:\\plugins\\one` } });
    const r = installMod({ packageDir: PKG, home, ...win });
    expect(r.alreadyListed).toBe(true);
    expect(r.changed).toBe(false);
    expect(verifyMod({ packageDir: PKG, home, ...win }).listed).toBe(true);
  });

  it('refuses a pluginConfigs entry of its own that is not an object, before copying anything', () => {
    writeSettings({ pluginConfigs: { 'crbro-pending': 'x' } });
    const r = installMod({ packageDir: PKG, home, lang: 'es', ...win });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/pluginConfigs\["crbro-pending"\] .* not touching it/);
    expect(existsSync(paths.installedDir)).toBe(false);

    writeSettings({ pluginConfigs: { 'crbro-pending': { options: 'ab' } } });
    const r2 = installMod({ packageDir: PKG, home, lang: 'es', ...win });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/\.options .* not touching it/);
    expect(settings()).toEqual({ pluginConfigs: { 'crbro-pending': { options: 'ab' } } });
  });

  it('--lang writes the "@inline" key too when Claude Code keeps one, and uninstall drops both', () => {
    writeSettings({ pluginConfigs: { 'crbro-pending@inline': { options: { language: 'en' } } } });
    installMod({ packageDir: PKG, home, lang: 'es', ...win });
    expect(settings().pluginConfigs).toEqual({
      'crbro-pending': { options: { language: 'es' } },
      'crbro-pending@inline': { options: { language: 'es' } },
    });
    uninstallMod({ home, ...win });
    expect(settings().pluginConfigs).toBeUndefined();
  });

  it('warns about folders only the process environment lists, and does not merge them', () => {
    const r = installMod({ packageDir: PKG, home, envDirs: `C:\\from\\shell;${paths.installedDir}`, ...win });
    expect(r.envOnly).toEqual(['C:\\from\\shell']);
    expect(r.lines.join('\n')).toMatch(/also set in this shell's environment/);
    expect(r.lines.join('\n')).toContain('C:\\from\\shell');
    expect(settings().env[PLUGIN_DIRS_VAR]).toBe(paths.installedDir);
    // Nothing to say when settings.json already holds them.
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: 'C:\\from\\shell' } });
    expect(installMod({ packageDir: PKG, home, envDirs: 'C:\\from\\shell', ...win }).envOnly).toEqual([]);
  });

  it('keeps the indentation settings.json had', () => {
    writeFileSync(paths.settingsPath, '{\n\t"theme": "dark"\n}\n');
    installMod({ packageDir: PKG, home, ...win });
    const raw = readFileSync(paths.settingsPath, 'utf8');
    expect(raw).toMatch(/\n\t"env": \{\n\t\t"CLAUDE_CODE_PLUGIN_DIRS"/);
    expect(existsSync(`${paths.settingsPath}.${process.pid}.tmp`)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('keeps the permission bits and writes through a symlink', () => {
    const real = join(home, 'dotfiles', 'settings.json');
    mkdirSync(join(home, 'dotfiles'), { recursive: true });
    writeFileSync(real, JSON.stringify({ theme: 'dark' }), { mode: 0o600 });
    chmodSync(real, 0o600);
    symlinkSync(real, paths.settingsPath);
    installMod({ packageDir: PKG, home, platform: 'linux' });
    expect(lstatSync(paths.settingsPath).isSymbolicLink()).toBe(true);
    expect(statSync(real).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(real, 'utf8')).env[PLUGIN_DIRS_VAR]).toBe(paths.installedDir);
  });

  it('clears a staging folder a failed run left behind', () => {
    const stale = join(paths.modsDir, 'crbro-pending.99999.tmp');
    mkdirSync(join(stale, 'hooks'), { recursive: true });
    writeFileSync(join(stale, 'hooks', 'half.ts'), '//');
    installMod({ packageDir: PKG, home, ...win });
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(paths.modsDir)).toEqual(['crbro-pending']);
  });

  it('--lang en|es stores the mod\'s language; auto takes it out again', () => {
    writeSettings({ pluginConfigs: { other: { options: { a: 1 } } } });
    installMod({ packageDir: PKG, home, lang: 'es', ...win });
    expect(settings().pluginConfigs).toEqual({ other: { options: { a: 1 } }, 'crbro-pending': { options: { language: 'es' } } });
    installMod({ packageDir: PKG, home, lang: 'en', ...win });
    expect(settings().pluginConfigs['crbro-pending']).toEqual({ options: { language: 'en' } });
    installMod({ packageDir: PKG, home, lang: 'auto', ...win });
    expect(settings().pluginConfigs).toEqual({ other: { options: { a: 1 } } });
    // No --lang: whatever is there stays.
    installMod({ packageDir: PKG, home, lang: 'es', ...win });
    installMod({ packageDir: PKG, home, ...win });
    expect(settings().pluginConfigs['crbro-pending']).toEqual({ options: { language: 'es' } });
  });

  it('refreshes a stale or tampered copy, dropping files the package no longer has', () => {
    installMod({ packageDir: PKG, home, ...win });
    writeFileSync(join(paths.installedDir, 'hooks', 'register.tsx'), '// changed\n');
    writeFileSync(join(paths.installedDir, 'hooks', 'old.ts'), '// gone\n');
    installMod({ packageDir: PKG, home, ...win });
    expect(verifyMod({ packageDir: PKG, home, ...win }).ok).toBe(true);
    expect(existsSync(join(paths.installedDir, 'hooks', 'old.ts'))).toBe(false);
  });

  it('without ~/.claude it installs nothing', () => {
    rmSync(paths.claudeDir, { recursive: true, force: true });
    const r = installMod({ packageDir: PKG, home, ...win });
    expect(r.ok).toBe(true);
    expect(r.skipped).toMatch(/~\/\.claude not found/);
    expect(existsSync(paths.claudeDir)).toBe(false);
  });
});

describe('uninstall-mod', () => {
  it('takes its path out of the list, deletes its folder and nothing else', () => {
    writeSettings({
      model: 'opus',
      env: { FOO: 'bar', [PLUGIN_DIRS_VAR]: 'C:\\plugins\\one' },
      pluginConfigs: { other: { options: { a: 1 } } },
    });
    installMod({ packageDir: PKG, home, lang: 'es', ...win });
    // Neighbours that must survive.
    mkdirSync(join(paths.modsDir, 'another-mod'), { recursive: true });
    writeFileSync(join(paths.modsDir, 'another-mod', 'x.txt'), 'keep');
    mkdirSync(join(paths.claudeDir, 'crbro-hooks'), { recursive: true });
    writeFileSync(join(paths.claudeDir, 'crbro-hooks', 'crbro-guard.mjs'), '// keep');
    const others = () => snapshot(home).split('\n').filter(l => !l.includes('crbro-pending') && !l.includes('settings.json')).join('\n');
    const before = others();

    const r = uninstallMod({ home, ...win });
    expect(r.ok).toBe(true);
    expect(r.removedDir).toBe(true);
    expect(existsSync(paths.installedDir)).toBe(false);
    expect(settings()).toEqual({
      model: 'opus',
      env: { FOO: 'bar', [PLUGIN_DIRS_VAR]: 'C:\\plugins\\one' },
      pluginConfigs: { other: { options: { a: 1 } } },
    });
    expect(others()).toBe(before);
    expect(existsSync(join(paths.modsDir, 'another-mod', 'x.txt'))).toBe(true);
  });

  it('drops the variable when the list ends up empty', () => {
    writeSettings({ env: { FOO: 'bar' } });
    installMod({ packageDir: PKG, home, ...win });
    uninstallMod({ home, ...win });
    expect(settings()).toEqual({ env: { FOO: 'bar' } });
  });

  it('leaves settings.json and ~/.claude as install-mod found them', () => {
    writeSettings({ theme: 'dark' });
    installMod({ packageDir: PKG, home, lang: 'en', ...win });
    uninstallMod({ home, ...win });
    expect(settings()).toEqual({ theme: 'dark' });
    expect(existsSync(paths.modsDir)).toBe(false);
  });

  it('puts the crbro-pendientes copy it replaced back where it was', () => {
    const legacy = pluginAt(join(home, 'my-mods', 'crbro-pendientes'), 'crbro-pendientes');
    const list = ['C:\\plugins\\one', legacy, 'C:\\plugins\\two'].join(';');
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: list } });
    installMod({ packageDir: PKG, home, ...win });
    expect(settings().env[PLUGIN_DIRS_VAR]).toBe(['C:\\plugins\\one', paths.installedDir, 'C:\\plugins\\two'].join(';'));
    // A second install has nothing to replace and keeps the record.
    installMod({ packageDir: PKG, home, ...win });

    const r = uninstallMod({ home, ...win });
    expect(r.restored).toEqual([legacy]);
    expect(settings().env[PLUGIN_DIRS_VAR]).toBe(list);
    expect(r.lines.join('\n')).toContain(`Put your earlier copy back in ${PLUGIN_DIRS_VAR}: ${legacy}`);
    expect(existsSync(paths.replacedPath)).toBe(false);
  });

  it('does not put back a replaced copy that is gone', () => {
    const legacy = pluginAt(join(home, 'my-mods', 'crbro-pendientes'), 'crbro-pendientes');
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: legacy } });
    installMod({ packageDir: PKG, home, ...win });
    rmSync(legacy, { recursive: true });
    const r = uninstallMod({ home, ...win });
    expect(r.restored).toEqual([]);
    expect(settings()).toEqual({});
    expect(r.lines.join('\n')).toMatch(/no longer there, so it was not put back/);
  });

  // A Windows home has a drive colon, so a ":" list cannot hold it there.
  it.skipIf(process.platform === 'win32')('keeps the rest of a ":" list outside Windows', () => {
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: `/opt/a:${paths.installedDir}:/opt/b` } });
    uninstallMod({ home, platform: 'linux' });
    expect(settings().env[PLUGIN_DIRS_VAR]).toBe('/opt/a:/opt/b');
  });

  it('refuses a settings.json that does not parse and keeps the folder', () => {
    installMod({ packageDir: PKG, home, ...win });
    writeFileSync(paths.settingsPath, 'nope');
    const r = uninstallMod({ home, ...win });
    expect(r.ok).toBe(false);
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe('nope');
    expect(existsSync(paths.installedDir)).toBe(true);
  });

  it('with nothing installed changes nothing', () => {
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: 'C:\\plugins\\one' } });
    const raw = readFileSync(paths.settingsPath, 'utf8');
    const r = uninstallMod({ home, ...win });
    expect(r.changed).toBe(false);
    expect(r.removedDir).toBe(false);
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe(raw);
    expect(r.lines.join('\n')).toMatch(/not installed/);
  });
});

describe('install-mod --verify', () => {
  it('a fresh install matches the package', () => {
    installMod({ packageDir: PKG, home, ...win });
    const r = verifyMod({ packageDir: PKG, home, ...win });
    expect(r.ok).toBe(true);
    expect(r.installed && r.listed).toBe(true);
    expect(r.files.every(f => f.status === 'same')).toBe(true);
    expect(formatModVerify(r)).toContain('matches this package');
  });

  it('nothing installed is not an error', () => {
    const r = verifyMod({ packageDir: PKG, home, ...win });
    expect(r.ok).toBe(true);
    expect(r.files).toEqual([]);
    expect(formatModVerify(r)).toContain('Not installed');
  });

  it('detects a changed, a missing and a foreign file, with hashes, and touches nothing', () => {
    installMod({ packageDir: PKG, home, ...win });
    const tampered = readFileSync(join(paths.installedDir, 'hooks', 'register.tsx'), 'utf8') + '\n// one extra line\n';
    writeFileSync(join(paths.installedDir, 'hooks', 'register.tsx'), tampered);
    rmSync(join(paths.installedDir, 'hooks', 'strings.ts'));
    writeFileSync(join(paths.installedDir, 'hooks', 'extra.ts'), 'export {}');
    const before = snapshot(home);

    const r = verifyMod({ packageDir: PKG, home, ...win });
    expect(r.ok).toBe(false);
    const byName = Object.fromEntries(r.files.map(f => [f.name, f]));
    expect(byName['hooks/register.tsx']!.status).toBe('different');
    expect(byName['hooks/register.tsx']!.installed_sha256).toBe(sha256(Buffer.from(tampered)));
    expect(byName['hooks/strings.ts']!.status).toBe('missing');
    expect(byName['hooks/extra.ts']!.status).toBe('unknown');
    expect(formatModVerify(r)).toContain('DIFFERENT');
    expect(snapshot(home)).toBe(before);
  });

  it('files the package never ships (node_modules, test, tsconfig, generated types) count as foreign', () => {
    installMod({ packageDir: PKG, home, ...win });
    const add = (rel: string) => {
      const target = join(paths.installedDir, ...rel.split('/'));
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'export {}');
    };
    for (const rel of ['node_modules/claude-code/index.js', 'test/x.test.tsx', 'tsconfig.json', '.claude-plugin/types/x.d.ts']) add(rel);
    const r = verifyMod({ packageDir: PKG, home, ...win });
    expect(r.ok).toBe(false);
    expect(r.files.filter(f => f.status === 'unknown').map(f => f.name).sort()).toEqual([
      '.claude-plugin/types/x.d.ts', 'node_modules/claude-code/index.js', 'test/x.test.tsx', 'tsconfig.json',
    ]);
  });

  it('another copy Claude Code would load beside it fails the check', () => {
    installMod({ packageDir: PKG, home, ...win });
    const local = pluginAt(join(paths.claudeDir, 'mods', 'crbro-pendientes'), 'crbro-pendientes');
    const r = verifyMod({ packageDir: PKG, home, ...win });
    expect(r.duplicates).toEqual([local]);
    expect(r.ok).toBe(false);
    expect(formatModVerify(r)).toContain(`Another copy is in ${local}`);
    expect(formatModVerify(r)).toContain('not the only copy');

    const checkout = pluginAt(join(home, 'src', 'crbro-pending'), 'crbro-pending');
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: [paths.installedDir, checkout].join(';') } });
    expect(verifyMod({ packageDir: PKG, home, ...win }).duplicates).toEqual([checkout, local]);
  });

  it('a copy of its own is no failure while this mod is not installed', () => {
    pluginAt(join(paths.claudeDir, 'mods', 'crbro-pendientes'), 'crbro-pendientes');
    const r = verifyMod({ packageDir: PKG, home, ...win });
    expect(r.ok).toBe(true);
    expect(r.duplicates).toEqual([]);
  });

  it('a list that only the process environment holds counts as listed', () => {
    installMod({ packageDir: PKG, home, ...win });
    writeSettings({});
    expect(verifyMod({ packageDir: PKG, home, envDirs: paths.installedDir, ...win }).listed).toBe(true);
    // settings.json's own value wins over the environment.
    writeSettings({ env: { [PLUGIN_DIRS_VAR]: 'C:\\plugins\\one' } });
    expect(verifyMod({ packageDir: PKG, home, envDirs: paths.installedDir, ...win }).listed).toBe(false);
  });

  it('CRLF against LF is line endings only', () => {
    installMod({ packageDir: PKG, home, ...win });
    const target = join(paths.installedDir, 'hooks', 'hooks.json');
    const text = readFileSync(join(PKG, 'hooks', 'hooks.json'), 'utf8').replace(/\r\n/g, '\n');
    const flipped = text.includes('\n') ? text.replace(/\n/g, '\r\n') : text + '\r\n';
    writeFileSync(target, flipped);
    const pkgCopy = join(home, 'pkg');
    // Compare against an LF package so the result does not depend on the checkout.
    for (const f of modFiles(PKG)) {
      const dest = join(pkgCopy, ...f.split('/'));
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, readFileSync(join(paths.installedDir, ...f.split('/'))));
    }
    writeFileSync(join(pkgCopy, 'hooks', 'hooks.json'), flipped.replace(/\r\n/g, '\n'));
    const r = verifyMod({ packageDir: pkgCopy, home, ...win });
    expect(r.files.find(f => f.name === 'hooks/hooks.json')!.status).toBe('line_endings_only');
    expect(r.ok).toBe(true);
  });

  it('a folder nobody lists, or a listed folder that is gone, is reported', () => {
    installMod({ packageDir: PKG, home, ...win });
    writeSettings({});
    const unlisted = verifyMod({ packageDir: PKG, home, ...win });
    expect(unlisted.ok).toBe(false);
    expect(formatModVerify(unlisted)).toContain('does not list it');

    writeSettings({ env: { [PLUGIN_DIRS_VAR]: paths.installedDir } });
    rmSync(paths.installedDir, { recursive: true });
    const gone = verifyMod({ packageDir: PKG, home, ...win });
    expect(gone.ok).toBe(false);
    expect(formatModVerify(gone)).toContain('which does not exist');
  });
});

describe.skipIf(!BUILT)('the CLI', () => {
  const run = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], {
    encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 30000,
  });

  it('install-mod, --verify, install-hooks --verify and uninstall-mod', () => {
    const inst = run('install-mod', '--lang', 'es');
    expect(inst.status).toBe(0);
    expect(inst.stdout).toContain('✅ Mod crbro-pending copied');
    expect(inst.stdout).toContain('Language: Spanish');
    expect(settings().pluginConfigs['crbro-pending'].options.language).toBe('es');
    expect(settings().env[PLUGIN_DIRS_VAR].split(process.platform === 'win32' ? ';' : ':')).toContain(paths.installedDir);

    expect(run('install-mod', '--verify').status).toBe(0);
    writeFileSync(join(paths.installedDir, 'hooks', 'register.tsx'), '// replaced\n');
    const bad = run('install-mod', '--verify', '--json');
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout).files.find((f: { name: string }) => f.name === 'hooks/register.tsx').status).toBe('different');
    // install-hooks --verify checks the mod as well.
    const hooks = run('install-hooks', '--verify', '--json');
    expect(hooks.status).toBe(1);
    expect(JSON.parse(hooks.stdout).mod.ok).toBe(false);

    const un = run('uninstall-mod');
    expect(un.status).toBe(0);
    expect(existsSync(paths.installedDir)).toBe(false);
    expect(settings().env?.[PLUGIN_DIRS_VAR]).toBeUndefined();
  });

  it('rejects an unknown --lang and a broken settings.json with exit 1', () => {
    expect(run('install-mod', '--lang', 'fr').status).toBe(1);
    writeFileSync(paths.settingsPath, '{ broken');
    const r = run('install-mod');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not touching it');
    expect(readFileSync(paths.settingsPath, 'utf8')).toBe('{ broken');
  });
});
