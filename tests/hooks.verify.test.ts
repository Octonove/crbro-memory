import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyHooks, formatVerify, sha256 } from '../src/engine/hookverify.js';

/**
 * `install-hooks --verify`: the installed copies against the package, by
 * SHA-256, read-only. Run against the real hooks/ of this package and a
 * throwaway ~/.claude.
 */
const PKG = join(__dirname, '..', 'hooks');
const CLI = join(__dirname, '..', 'bin', 'crbro.mjs');

let home: string;
let installed: string;
let settingsPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'crbro-verify-'));
  installed = join(home, '.claude', 'crbro-hooks');
  settingsPath = join(home, '.claude', 'settings.json');
  mkdirSync(installed, { recursive: true });
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const shipped = () => readdirSync(PKG).filter(f => f.endsWith('.mjs')).sort();
const installAll = () => { for (const f of shipped()) copyFileSync(join(PKG, f), join(installed, f)); };
const settingsFor = (names: string[]) => writeFileSync(settingsPath, JSON.stringify({
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: names.map(n => ({ type: 'command', command: `node "${join(installed, n).split('\\').join('/')}"` })) }],
    Stop: [{ hooks: [{ type: 'command', command: 'echo not ours' }] }],
  },
}, null, 2));

/** Every file under a folder with its mtime and size, to prove nothing was touched. */
function snapshot(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) walk(p); else out.push(`${p}|${st.size}|${st.mtimeMs}|${sha256(readFileSync(p))}`);
    }
  };
  walk(dir);
  return out.sort().join('\n');
}

describe('install-hooks --verify', () => {
  it('copies identical to the package pass', () => {
    installAll();
    settingsFor(shipped());
    const r = verifyHooks({ packageDir: PKG, installedDir: installed, settingsPath });
    expect(r.ok).toBe(true);
    expect(r.hooks.every(h => h.status === 'same' && h.in_settings)).toBe(true);
    expect(r.hooks.map(h => h.name)).toEqual(shipped());
    expect(formatVerify(r)).toContain('Everything matches');
  });

  it('detects a modified hook, with both hashes, and touches nothing', () => {
    installAll();
    settingsFor(shipped());
    const victim = 'crbro-guard.mjs';
    const tampered = readFileSync(join(installed, victim), 'utf8') + '\n// one extra line\n';
    writeFileSync(join(installed, victim), tampered);
    const before = snapshot(join(home, '.claude'));

    const r = verifyHooks({ packageDir: PKG, installedDir: installed, settingsPath });
    expect(r.ok).toBe(false);
    const h = r.hooks.find(x => x.name === victim)!;
    expect(h.status).toBe('different');
    expect(h.installed_sha256).toBe(sha256(Buffer.from(tampered)));
    expect(h.package_sha256).toBe(sha256(readFileSync(join(PKG, victim))));
    expect(r.hooks.filter(x => x.name !== victim).every(x => x.status === 'same')).toBe(true);
    const text = formatVerify(r);
    expect(text).toContain('DIFFERENT');
    expect(text).toContain(h.installed_sha256!);

    expect(snapshot(join(home, '.claude'))).toBe(before);
  });

  it('CRLF against LF is reported as line endings only, not as a change', () => {
    const name = shipped()[0];
    const lf = readFileSync(join(PKG, name), 'utf8').replace(/\r\n/g, '\n');
    writeFileSync(join(installed, name), lf.replace(/\n/g, '\r\n'));
    const r = verifyHooks({ packageDir: PKG, installedDir: installed, settingsPath });
    expect(r.hooks.find(h => h.name === name)!.status).toBe('line_endings_only');
    expect(r.ok).toBe(true);
  });

  it('flags a hook settings.json runs that is not on disk, and a stranger in crbro-hooks/', () => {
    settingsFor(['crbro-guard.mjs']);   // referenced, never copied
    writeFileSync(join(installed, 'crbro-extra.mjs'), 'console.log("hi")');
    const r = verifyHooks({ packageDir: PKG, installedDir: installed, settingsPath });
    expect(r.ok).toBe(false);
    expect(r.missing_scripts).toHaveLength(1);
    expect(r.missing_scripts[0]).toMatch(/crbro-guard\.mjs$/);
    expect(r.hooks.find(h => h.name === 'crbro-extra.mjs')!.status).toBe('unknown');
    expect(r.hooks.find(h => h.name === 'crbro-guard.mjs')!.status).toBe('not_installed');
  });

  it('nothing installed is not an error', () => {
    const r = verifyHooks({ packageDir: PKG, installedDir: join(home, 'nowhere'), settingsPath: join(home, 'none.json') });
    expect(r.ok).toBe(true);
    expect(r.hooks.every(h => h.status === 'not_installed')).toBe(true);
  });

  it('an unparseable settings.json is reported, not rewritten', () => {
    writeFileSync(settingsPath, '{ not json');
    const r = verifyHooks({ packageDir: PKG, installedDir: installed, settingsPath });
    expect(r.settings_unreadable).toBe(true);
    expect(r.ok).toBe(false);
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ not json');
  });

  it.skipIf(!existsSync(join(__dirname, '..', 'dist', 'engine', 'hookverify.js')))('the CLI exits 1 on a modified hook and 0 when all match', () => {
    installAll();
    settingsFor(shipped());
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const ok = spawnSync(process.execPath, [CLI, 'install-hooks', '--verify'], { encoding: 'utf8', env, timeout: 30000 });
    expect(ok.status).toBe(0);
    writeFileSync(join(installed, 'crbro-subagent.mjs'), '// replaced\n');
    const bad = spawnSync(process.execPath, [CLI, 'install-hooks', '--verify', '--json'], { encoding: 'utf8', env, timeout: 30000 });
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout).hooks.find((h: { name: string }) => h.name === 'crbro-subagent.mjs').status).toBe('different');
    // --verify never installs: settings.json is exactly what the test wrote.
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).hooks.SubagentStart).toBeUndefined();
  });
});
