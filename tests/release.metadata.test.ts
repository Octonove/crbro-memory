// ─── Release metadata (2.7) ──────────────────────────────────────
//
// 2.6.0 shipped with package.json at 2.6.0 and server.json / package-lock.json
// still at 2.5.1: the MCP registry and the lockfile described a release that
// was not the one on npm. And a file the CLI imports is only on a user's disk
// if package.json "files" lets it into the tarball. These checks are cheap and
// read only the repo, so they catch both before a release, not after.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { modFiles } from '../src/engine/modinstall.js';

const root = path.resolve(__dirname, '..');
const read = (f: string) => readFileSync(path.join(root, f), 'utf8');
const json = (f: string) => JSON.parse(read(f));

const pkg = json('package.json');
const files: string[] = pkg.files;

/** Whether a repo-relative path is shipped by the "files" field (npm always adds package.json). */
function shipped(rel: string): boolean {
  return files.some(f => (f.endsWith('/') ? rel.startsWith(f) : rel === f));
}

describe('release metadata', () => {
  it('package.json, server.json and package-lock.json carry the same version', () => {
    const server = json('server.json');
    const lock = json('package-lock.json');
    expect(server.version).toBe(pkg.version);
    for (const p of server.packages) expect(p.version).toBe(pkg.version);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
  });

  it('the newest released CHANGELOG section is this version', () => {
    const first = read('CHANGELOG.md').match(/^## \[(\d+\.\d+\.\d+)\]/m);
    expect(first?.[1]).toBe(pkg.version);
  });

  it('every module the CLI imports from dist/ has a source and ships', () => {
    const bin = read('bin/crbro.mjs');
    const targets = new Set([...bin.matchAll(/['"]\.\.\/dist\/([\w/.-]+)\.js['"]/g)].map(m => m[1]));
    expect(targets.size).toBeGreaterThan(0);
    for (const t of targets) {
      expect(existsSync(path.join(root, 'src', `${t}.ts`)), `src/${t}.ts`).toBe(true);
      expect(shipped(`dist/${t}.js`), `dist/${t}.js`).toBe(true);
    }
  });

  it('every hook the CLI installs exists and ships', () => {
    const bin = read('bin/crbro.mjs');
    // The copies install-hooks makes: join(here, '..', 'hooks', 'crbro-x.mjs').
    const hooks = new Set([...bin.matchAll(/'hooks',\s*'(crbro-[\w-]+\.mjs)'/g)].map(m => m[1]));
    for (const h of ['crbro-lifecycle.mjs', 'crbro-guard.mjs', 'crbro-subagent.mjs']) expect(hooks.has(h), h).toBe(true);
    for (const h of hooks) {
      expect(existsSync(path.join(root, 'hooks', h)), `hooks/${h}`).toBe(true);
      expect(shipped(`hooks/${h}`), `hooks/${h}`).toBe(true);
    }
  });

  it('the mod install-mod copies exists and ships', () => {
    const bin = read('bin/crbro.mjs');
    expect(bin).toMatch(/'mods',\s*'crbro-pending'/);
    // Every file install-mod copies, so a new one (strings.ts was the first)
    // cannot be left out of the tarball while the suite stays green.
    const modDir = path.join(root, 'mods', 'crbro-pending');
    const copied = modFiles(modDir);
    const ignored = read('mods/crbro-pending/.npmignore').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    for (const f of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.tsx', 'hooks/strings.ts', 'types/index.d.ts']) {
      expect(copied, f).toContain(f);
    }
    for (const f of copied) {
      expect(shipped(`mods/crbro-pending/${f}`), f).toBe(true);
      expect(ignored.some(rule => (rule.endsWith('/') ? f.startsWith(rule) : f === rule)), `.npmignore drops ${f}`).toBe(false);
    }
  });

  it('SECURITY.md exists, ships and is linked from the README', () => {
    expect(existsSync(path.join(root, 'SECURITY.md'))).toBe(true);
    expect(shipped('SECURITY.md')).toBe(true);
    expect(read('README.md')).toMatch(/\]\([^)]*SECURITY\.md\)/);
  });
});
