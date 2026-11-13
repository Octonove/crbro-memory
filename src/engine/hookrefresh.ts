// ─── Installed hooks stay current on their own ───────────────────
//
// install-hooks and install-boot copy hooks/*.mjs out of the package into a
// stable folder — <Claude config>/crbro-hooks, <CODEX_HOME>/crbro-hooks —
// because the npx cache moves with every release. Until 2.11 nothing ever
// updated those copies: an update of CRBRO left the old guard (silent once the
// trigger index format moved) and the old lifecycle hook (an older copy of the
// secret filter) running for good.
//
// Each of those folders now keeps a manifest of what CRBRO put there: the
// version and the LF SHA-256 of every file. When the running package is a
// different build, a copy that is still byte for byte what CRBRO installed —
// by the manifest, or by the list of every hook CRBRO ever shipped for copies
// installed before manifests existed — is replaced by the package's. A copy
// that matches neither was edited by someone: it is left alone and reported,
// by doctor always and by the boot once (hooks_notice).
//
// Runs from crbro_boot (beside the mod's automatic install) and from every
// install command. Never creates a folder, never adds a hook to a client's
// settings: it only keeps current what is already there.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { backupFile, claudeDir, codexHome, lfSha } from './installio.js';

export const HOOK_MANIFEST = 'crbro-hooks.manifest.json';
export const SHIPPED_HASHES = 'crbro-hooks.shipped.json';

export interface HookManifest {
  version: string;
  /** file name → LF sha256 of the copy CRBRO wrote. */
  files: Record<string, string>;
  /** "name:sha" of edited copies already reported at boot, so it is said once. */
  noticed?: string[];
}

export interface HookDir {
  client: 'claude-code' | 'codex';
  dir: string;
}

export function hookDirs(home: string, env: NodeJS.ProcessEnv = process.env): HookDir[] {
  return [
    { client: 'claude-code', dir: path.join(claudeDir(home, env), 'crbro-hooks') },
    { client: 'codex', dir: path.join(codexHome(home, env), 'crbro-hooks') },
  ];
}

/** The hooks/ folder of the package this code runs from. */
export function packageHooksDir(): string {
  return path.join(__dirname, '..', '..', 'hooks');
}

export function readManifest(dir: string): HookManifest | null {
  try {
    const m = JSON.parse(readFileSync(path.join(dir, HOOK_MANIFEST), 'utf8'));
    if (m && typeof m === 'object' && m.files && typeof m.files === 'object') {
      return { version: String(m.version ?? ''), files: m.files, noticed: Array.isArray(m.noticed) ? m.noticed : [] };
    }
  } catch { /* none yet */ }
  return null;
}

function writeManifest(dir: string, m: HookManifest): void {
  const file = path.join(dir, HOOK_MANIFEST);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

/** Every LF hash CRBRO has shipped for a hook, from the package's list. */
export function shippedHashes(pkgHooks: string): Record<string, string[]> {
  try {
    const raw = JSON.parse(readFileSync(path.join(pkgHooks, SHIPPED_HASHES), 'utf8'));
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) out[k] = v.filter(x => typeof x === 'string');
    return out;
  } catch {
    return {};
  }
}

function pkgVersion(pkgHooks: string): string {
  try {
    return String(JSON.parse(readFileSync(path.join(pkgHooks, '..', 'package.json'), 'utf8')).version || 'unknown');
  } catch {
    return 'unknown';
  }
}

function mjsIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter(f => f.endsWith('.mjs') && statSync(path.join(dir, f)).isFile()).sort();
  } catch {
    return [];
  }
}

/** Copies one packaged hook into a folder (tmp + rename) and records it in that folder's manifest. */
export function installHookFile(pkgHooks: string, name: string, targetDir: string): string {
  mkdirSync(targetDir, { recursive: true });
  const src = readFileSync(path.join(pkgHooks, name));
  const target = path.join(targetDir, name);
  // A copy somebody edited is kept aside before it is replaced.
  try {
    const mine = lfSha(readFileSync(target));
    const known = readManifest(targetDir)?.files[name] === mine || (shippedHashes(pkgHooks)[name] ?? []).includes(mine);
    if (mine !== lfSha(src) && !known) backupFile(target);
  } catch { /* not there yet */ }
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, src);
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  const m = readManifest(targetDir) ?? { version: pkgVersion(pkgHooks), files: {} };
  m.version = pkgVersion(pkgHooks);
  m.files[name] = lfSha(src);
  writeManifest(targetDir, m);
  return target;
}

export type HookCopyState =
  /** Same text as the package's. */
  | 'current'
  /** An unmodified copy of an older release: refreshed (or, read-only, would be). */
  | 'stale'
  /** Not what CRBRO installed: somebody edited it. Left alone. */
  | 'modified';

export interface HookCopy {
  client: HookDir['client'];
  dir: string;
  name: string;
  state: HookCopyState;
  /** It was replaced by this run. */
  refreshed?: boolean;
  error?: string;
}

export interface RefreshOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  pkgHooks?: string;
  /** Look only: report what would be refreshed. */
  dryRun?: boolean;
}

/**
 * Checks every installed CRBRO hook against the package; refreshes the
 * unmodified ones unless dryRun. Never throws: a copy it cannot write is
 * reported with its error and tried again next time.
 */
export function refreshHooks(opts: RefreshOptions): HookCopy[] {
  const pkgHooks = opts.pkgHooks ?? packageHooksDir();
  const shipped = shippedHashes(pkgHooks);
  const version = pkgVersion(pkgHooks);
  const out: HookCopy[] = [];
  for (const { client, dir } of hookDirs(opts.home, opts.env ?? process.env)) {
    if (!existsSync(dir)) continue;
    const manifest = readManifest(dir);
    let manifestChanged = false;
    const next: HookManifest = manifest ? { ...manifest, files: { ...manifest.files } } : { version, files: {} };
    for (const name of mjsIn(dir)) {
      let pkg: Buffer;
      try { pkg = readFileSync(path.join(pkgHooks, name)); } catch { continue; }   // not a hook of this package
      let mine: Buffer;
      try { mine = readFileSync(path.join(dir, name)); } catch { continue; }
      const pkgSha = lfSha(pkg);
      const mineSha = lfSha(mine);
      if (mineSha === pkgSha) {
        out.push({ client, dir, name, state: 'current' });
        if (next.files[name] !== pkgSha) { next.files[name] = pkgSha; manifestChanged = true; }
        continue;
      }
      const ours = next.files[name] === mineSha || (shipped[name] ?? []).includes(mineSha);
      if (!ours) { out.push({ client, dir, name, state: 'modified' }); continue; }
      const row: HookCopy = { client, dir, name, state: 'stale' };
      if (!opts.dryRun) {
        const target = path.join(dir, name);
        const tmp = `${target}.${process.pid}.tmp`;
        try {
          // Checked once more right before: an edit made since the read is not overwritten.
          if (lfSha(readFileSync(target)) !== mineSha) throw new Error('changed while being refreshed');
          writeFileSync(tmp, pkg);
          renameSync(tmp, target);
          row.refreshed = true;
          next.files[name] = pkgSha;
          manifestChanged = true;
        } catch (e) {
          rmSync(tmp, { force: true });
          row.error = (e as Error).message;
        }
      }
      out.push(row);
    }
    if (!opts.dryRun && (manifestChanged || (manifest && manifest.version !== version && out.some(c => c.dir === dir && c.state !== 'modified')))) {
      try {
        next.version = version;
        writeManifest(dir, next);
      } catch { /* the next run writes it */ }
    }
  }
  return out;
}

/**
 * The sentence for the boot, once per edited copy: the copies CRBRO did not
 * refresh because someone changed them, and refreshes that failed. Null when
 * there is nothing new to say. Marks what it said in the manifests.
 */
export function hooksNotice(copies: HookCopy[]): string | null {
  const edited = copies.filter(c => c.state === 'modified');
  const failed = copies.filter(c => c.error);
  const fresh: HookCopy[] = [];
  for (const c of edited) {
    let sha = '';
    try { sha = lfSha(readFileSync(path.join(c.dir, c.name))); } catch { continue; }
    const m = readManifest(c.dir);
    const key = `${c.name}:${sha}`;
    if (m?.noticed?.includes(key)) continue;
    fresh.push(c);
    try {
      const next = m ?? { version: '', files: {} };
      next.noticed = [...(next.noticed ?? []), key].slice(-50);
      writeManifest(c.dir, next);
    } catch { /* said again next time */ }
  }
  if (!fresh.length && !failed.length) return null;
  const parts: string[] = [];
  if (fresh.length) {
    parts.push(`CRBRO did not update ${fresh.length} installed hook file(s) because they differ from what CRBRO installed (edited by hand?): ` +
      fresh.map(c => path.join(c.dir, c.name)).join(', ') + '.');
    parts.push('They keep running as they are. To take this version\'s copy, run the install command again (npx crbro-memory install-hooks …, or install), which replaces them after a backup; npx crbro-memory doctor lists them.');
  }
  if (failed.length) {
    parts.push(`CRBRO could not refresh ${failed.map(c => path.join(c.dir, c.name)).join(', ')} (${failed[0].error}); it tries again at the next start.`);
  }
  parts.push('Tell the user this once, briefly, in their language.');
  return parts.join(' ');
}
