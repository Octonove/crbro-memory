import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { HOOK_MANIFEST, hooksNotice, installHookFile, readManifest, refreshHooks } from '../src/engine/hookrefresh.js';
import { resetModOnBoot, startModOnBoot, takeHooksNotice, staleStaging } from '../src/engine/modinstall.js';

/**
 * Installed hook copies follow the package on their own when nobody touched
 * them, and are left alone — and reported once — when somebody did.
 */
const lf = (s: string) => createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex');
let home: string, pkg: string, claudeHooks: string, codexHooks: string;
const env = () => ({ HOME: home, USERPROFILE: home } as NodeJS.ProcessEnv);

function makePackage(version: string, files: Record<string, string>, shipped: Record<string, Record<string, string>> = {}) {
  rmSync(pkg, { recursive: true, force: true });
  mkdirSync(join(pkg, 'hooks'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'crbro-memory', version }));
  for (const [n, t] of Object.entries(files)) writeFileSync(join(pkg, 'hooks', n), t);
  writeFileSync(join(pkg, 'hooks', 'crbro-hooks.shipped.json'), JSON.stringify(shipped));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'crbro-refresh-'));
  pkg = join(home, 'pkg');
  claudeHooks = join(home, '.claude', 'crbro-hooks');
  codexHooks = join(home, '.codex', 'crbro-hooks');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('hook copies follow the package', () => {
  it('a copy installed by an earlier version (manifest) is refreshed; the manifest moves with it', () => {
    makePackage('2.10.0', { 'crbro-guard.mjs': 'old guard' });
    installHookFile(join(pkg, 'hooks'), 'crbro-guard.mjs', claudeHooks);
    expect(readManifest(claudeHooks)).toMatchObject({ version: '2.10.0', files: { 'crbro-guard.mjs': { sha256: lf('old guard'), version: '2.10.0' } } });

    makePackage('2.11.0', { 'crbro-guard.mjs': 'new guard' });
    const r = refreshHooks({ home, env: env(), pkgHooks: join(pkg, 'hooks') });

    expect(r).toEqual([expect.objectContaining({ name: 'crbro-guard.mjs', state: 'stale', refreshed: true })]);
    expect(readFileSync(join(claudeHooks, 'crbro-guard.mjs'), 'utf8')).toBe('new guard');
    expect(readManifest(claudeHooks)).toMatchObject({ version: '2.11.0', files: { 'crbro-guard.mjs': { sha256: lf('new guard'), version: '2.11.0' } } });
  });

  it('a copy from before manifests is recognised by the list of every hook CRBRO shipped', () => {
    makePackage('2.11.0', { 'crbro-lifecycle.mjs': 'new' }, { 'crbro-lifecycle.mjs': { [lf('2.7 lifecycle')]: '2.7.0' } });
    mkdirSync(claudeHooks, { recursive: true });
    writeFileSync(join(claudeHooks, 'crbro-lifecycle.mjs'), '2.7 lifecycle'.replace(/\n/g, '\r\n'));

    refreshHooks({ home, env: env(), pkgHooks: join(pkg, 'hooks') });

    expect(readFileSync(join(claudeHooks, 'crbro-lifecycle.mjs'), 'utf8')).toBe('new');
  });

  it('an edited copy is left alone, reported once, and taken over with a backup only on an explicit install', () => {
    makePackage('2.11.0', { 'crbro-guard.mjs': 'new guard' }, { 'crbro-guard.mjs': { [lf('old guard')]: '2.10.0' } });
    mkdirSync(claudeHooks, { recursive: true });
    writeFileSync(join(claudeHooks, 'crbro-guard.mjs'), 'my edited guard');

    const r = refreshHooks({ home, env: env(), pkgHooks: join(pkg, 'hooks') });
    expect(r[0].state).toBe('modified');
    expect(readFileSync(join(claudeHooks, 'crbro-guard.mjs'), 'utf8')).toBe('my edited guard');
    const notice = hooksNotice(r);
    expect(notice).toContain(join(claudeHooks, 'crbro-guard.mjs'));
    expect(hooksNotice(refreshHooks({ home, env: env(), pkgHooks: join(pkg, 'hooks') })), 'said once').toBeNull();

    installHookFile(join(pkg, 'hooks'), 'crbro-guard.mjs', claudeHooks);
    expect(readFileSync(join(claudeHooks, 'crbro-guard.mjs'), 'utf8')).toBe('new guard');
    const backup = readdirSync(claudeHooks).find(n => n.startsWith('crbro-guard.mjs.crbro-bak-'));
    expect(backup && readFileSync(join(claudeHooks, backup), 'utf8')).toBe('my edited guard');
  });

  it('dry run reports and writes nothing; a current copy (CRLF or not) is current; Codex\'s folder too', () => {
    makePackage('2.11.0', { 'crbro-codex.mjs': 'a\nb\n', 'crbro-guard.mjs': 'new' }, { 'crbro-guard.mjs': { [lf('old')]: '2.10.0' } });
    mkdirSync(codexHooks, { recursive: true });
    writeFileSync(join(codexHooks, 'crbro-codex.mjs'), 'a\r\nb\r\n');
    writeFileSync(join(codexHooks, 'crbro-guard.mjs'), 'old');

    const r = refreshHooks({ home, env: env(), pkgHooks: join(pkg, 'hooks'), dryRun: true });

    expect(r.map(c => [c.client, c.name, c.state])).toEqual([['codex', 'crbro-codex.mjs', 'current'], ['codex', 'crbro-guard.mjs', 'stale']]);
    expect(readFileSync(join(codexHooks, 'crbro-guard.mjs'), 'utf8')).toBe('old');
    expect(existsSync(join(codexHooks, HOOK_MANIFEST))).toBe(false);
  });

  it('only a newer release replaces a copy: another build of the same version, or an older one, leaves it alone', () => {
    makePackage('2.11.0', { 'crbro-guard.mjs': 'build A' });
    installHookFile(join(pkg, 'hooks'), 'crbro-guard.mjs', claudeHooks);
    makePackage('2.11.0', { 'crbro-guard.mjs': 'build B (a checkout)' });
    expect(refreshHooks({ home, env: env(), pkgHooks: join(pkg, 'hooks') })[0].state).toBe('other_build');
    makePackage('2.10.0', { 'crbro-guard.mjs': 'older' });
    expect(refreshHooks({ home, env: env(), pkgHooks: join(pkg, 'hooks') })[0].state).toBe('other_build');
    expect(readFileSync(join(claudeHooks, 'crbro-guard.mjs'), 'utf8')).toBe('build A');
    makePackage('2.12.0', { 'crbro-guard.mjs': 'newer' });
    expect(refreshHooks({ home, env: env(), pkgHooks: join(pkg, 'hooks') })[0]).toMatchObject({ state: 'stale', refreshed: true });
    expect(readFileSync(join(claudeHooks, 'crbro-guard.mjs'), 'utf8')).toBe('newer');
  });

  it('never creates a hooks folder that was not there', () => {
    makePackage('2.11.0', { 'crbro-guard.mjs': 'new' });
    expect(refreshHooks({ home, env: env(), pkgHooks: join(pkg, 'hooks') })).toEqual([]);
    expect(existsSync(claudeHooks)).toBe(false);
  });
});

describe('at boot', () => {
  it('a guard installed by 2.5.1 (from git history) is brought to this release by crbro_boot, even with CRBRO_MOD=0', async () => {
    const old = execFileSync('git', ['show', 'c1edbb8:hooks/crbro-guard.mjs'], { cwd: join(__dirname, '..'), encoding: 'utf8' });
    mkdirSync(claudeHooks, { recursive: true });
    writeFileSync(join(claudeHooks, 'crbro-guard.mjs'), old);
    resetModOnBoot();

    await startModOnBoot({ home, env: { ...env(), CRBRO_MOD: '0' }, budgetMs: 5000 })();

    const current = readFileSync(join(__dirname, '..', 'hooks', 'crbro-guard.mjs'), 'utf8');
    expect(lf(readFileSync(join(claudeHooks, 'crbro-guard.mjs'), 'utf8'))).toBe(lf(current));
    expect(takeHooksNotice(), 'nothing edited, nothing to say').toBeNull();
    resetModOnBoot();
  });

  it('CRBRO_HOOK_REFRESH=0 leaves the copies as they are', async () => {
    const old = execFileSync('git', ['show', 'c1edbb8:hooks/crbro-guard.mjs'], { cwd: join(__dirname, '..'), encoding: 'utf8' });
    mkdirSync(claudeHooks, { recursive: true });
    writeFileSync(join(claudeHooks, 'crbro-guard.mjs'), old);
    resetModOnBoot();

    await startModOnBoot({ home, env: { ...env(), CRBRO_MOD: '0', CRBRO_HOOK_REFRESH: '0' }, budgetMs: 2000 })();

    expect(readFileSync(join(claudeHooks, 'crbro-guard.mjs'), 'utf8')).toBe(old);
    resetModOnBoot();
  });
});

describe('mod staging folders (I16)', () => {
  it('only a dead owner\'s staging folder is removed', () => {
    expect(staleStaging('crbro-pending.123.tmp', () => true)).toBe(false);
    expect(staleStaging('crbro-pending.123.old', () => false)).toBe(true);
    expect(staleStaging(`crbro-pending.${process.pid}.tmp`, () => true)).toBe(true);
    expect(staleStaging('crbro-pending', () => false)).toBe(false);
    expect(staleStaging('something.123.tmp', () => false)).toBe(false);
  });
});
