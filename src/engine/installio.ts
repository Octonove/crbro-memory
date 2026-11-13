// ─── Where the clients keep their config, and how CRBRO writes to it ─────
//
// Every installer in this package writes into files that belong to another
// program: Claude Code's settings.json, Codex's hooks.json and config.toml,
// Claude Desktop's and Cursor's MCP lists. Those files are the user's, and an
// editor, the client itself or a dotfiles manager may be holding them. So
// every write goes through writeGuarded():
//
//   - a timestamped copy of the file as it was is kept beside it first
//     (<file>.crbro-bak-<UTC stamp>; the newest few per file are kept);
//   - the file is hashed again right before the rename, and nothing is written
//     when it changed after it was read (ESETTINGSCHANGED: read and merge again);
//   - a symlinked file is written at its target, so the link stays a link, and
//     the permission bits and line endings it had are kept.
//
// modinstall.ts grew this first for the Claude Code mod; it now uses this one.
//
// The folders honour the variables the clients themselves honour:
// CLAUDE_CONFIG_DIR (Claude Code) and CODEX_HOME (Codex).

import { createHash } from 'crypto';
import {
  copyFileSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  writeFileSync,
} from 'fs';
import path from 'path';

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** SHA-256 of a text read with LF line endings: a CRLF checkout and the npm copy hash the same. */
export function lfSha(buf: Buffer | string): string {
  const text = typeof buf === 'string' ? buf : buf.toString('utf8');
  return sha256(Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8'));
}

// ─── Folders ─────────────────────────────────────────────────────

function fromEnv(value: string | undefined, home: string): string | null {
  const raw = (value || '').trim();
  if (!raw || /\$\{|%[A-Za-z_][A-Za-z0-9_]*%/.test(raw)) return null;
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(home, raw.slice(1));
  return path.resolve(raw);
}

/** Claude Code's config folder: CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return fromEnv(env.CLAUDE_CONFIG_DIR, home) ?? path.join(home, '.claude');
}

/** Where Claude Code keeps user-scope MCP servers: <CLAUDE_CONFIG_DIR>/.claude.json, else ~/.claude.json. */
export function claudeJson(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = fromEnv(env.CLAUDE_CONFIG_DIR, home);
  return dir ? path.join(dir, '.claude.json') : path.join(home, '.claude.json');
}

/** Codex's folder: CODEX_HOME, else ~/.codex. */
export function codexHome(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return fromEnv(env.CODEX_HOME, home) ?? path.join(home, '.codex');
}

export function claudeDesktopConfig(home: string, env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

export function cursorConfig(home: string): string {
  return path.join(home, '.cursor', 'mcp.json');
}

/** The stable engine folder `crbro-memory install` copies the package into. */
export function engineRoot(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return fromEnv(env.CRBRO_ENGINE_DIR, home) ?? path.join(home, '.crbro-engine');
}

// ─── Reading ─────────────────────────────────────────────────────

export interface TextRead {
  exists: boolean;
  text: string;
  /** sha256 of the bytes as read, or "absent". */
  hash: string;
  eol: '\n' | '\r\n';
  bom: boolean;
}

export function readText(file: string): TextRead {
  if (!existsSync(file)) return { exists: false, text: '', hash: 'absent', eol: '\n', bom: false };
  const buf = readFileSync(file);
  let text = buf.toString('utf8');
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  return { exists: true, text, hash: sha256(buf), eol: /\r\n/.test(text) ? '\r\n' : '\n', bom };
}

/** What a file holds right now, as a hash, or "absent". */
export function fingerprint(file: string): string {
  try {
    return sha256(readFileSync(file));
  } catch {
    return 'absent';
  }
}

export type JsonRead =
  | { ok: true; value: Record<string, any> | null; indent: string | number; eol: '\n' | '\r\n'; bom: boolean; hash: string }
  | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A JSON object file; null when absent. Anything that is not an object is refused, never guessed at. */
export function readJsonObject(file: string): JsonRead {
  let read: TextRead;
  try {
    read = readText(file);
  } catch (e) {
    return { ok: false, error: `${file} could not be read — not touching it.\n     ${(e as Error).message}` };
  }
  if (!read.exists) return { ok: true, value: null, indent: 2, eol: '\n', bom: false, hash: 'absent' };
  let value: unknown;
  try {
    value = read.text.trim() ? JSON.parse(read.text) : {};
  } catch (e) {
    return { ok: false, error: `${file} exists but could not be parsed — not touching it.\n     ${(e as Error).message}` };
  }
  if (!isObject(value)) return { ok: false, error: `${file} is not a JSON object — not touching it.` };
  const indent = /\n([ \t]+)"/.exec(read.text)?.[1] ?? 2;
  return { ok: true, value, indent, eol: read.eol, bom: read.bom, hash: read.hash };
}

// ─── Writing ─────────────────────────────────────────────────────

/** Thrown by writeGuarded when the file changed after it was read: the caller reads and merges again. */
export const FILE_CHANGED = 'ESETTINGSCHANGED';
export const BACKUP_TAG = '.crbro-bak-';
/** Backups kept per file; older ones of the same file go. */
export const BACKUPS_KEPT = 5;

export interface WriteOptions {
  /** The hash the file had when it was read ("absent" when it did not exist). Nothing is written if it changed. */
  expectHash?: string;
  /** Keep a timestamped copy of the current file first. Default true. */
  backup?: boolean;
  now?: () => Date;
}

function stampOf(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** The backups of one file, oldest first. */
export function backupsOf(file: string): string[] {
  const dir = path.dirname(file);
  const prefix = path.basename(file) + BACKUP_TAG;
  try {
    return readdirSync(dir).filter(n => n.startsWith(prefix)).sort().map(n => path.join(dir, n));
  } catch {
    return [];
  }
}

/** Copies the file aside, returns the copy's path, or null when there was nothing to copy. */
export function backupFile(file: string, now: () => Date = () => new Date()): string | null {
  if (!existsSync(file)) return null;
  let target = `${file}${BACKUP_TAG}${stampOf(now())}`;
  for (let i = 1; existsSync(target); i++) target = `${file}${BACKUP_TAG}${stampOf(now())}-${i}`;
  copyFileSync(file, target);
  const all = backupsOf(file);
  for (const old of all.slice(0, Math.max(0, all.length - BACKUPS_KEPT))) {
    try { rmSync(old, { force: true }); } catch { /* the next write tries again */ }
  }
  return target;
}

/**
 * Writes text through .tmp + rename, after a backup, and only if the file is
 * still what was read. Returns the backup path (or null when the file did not
 * exist before). On Windows the renamed file takes the folder's inherited ACL.
 */
export function writeGuarded(file: string, text: string, opts: WriteOptions = {}): string | null {
  let target = file;
  try {
    if (lstatSync(file).isSymbolicLink()) target = realpathSync(file);
  } catch {
    // Not there yet: written as a plain file.
  }
  let mode: number | undefined;
  try {
    mode = statSync(target).mode & 0o777;
  } catch {
    mode = undefined;
  }
  if (opts.expectHash !== undefined && fingerprint(target) !== opts.expectHash) throw changedError(file);
  const backup = opts.backup === false ? null : backupFile(target, opts.now);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
    if (opts.expectHash !== undefined && fingerprint(target) !== opts.expectHash) throw changedError(file);
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return backup;
}

function changedError(file: string): NodeJS.ErrnoException {
  const changed = new Error(`${file} changed while it was being written.`) as NodeJS.ErrnoException;
  changed.code = FILE_CHANGED;
  return changed;
}

/** JSON in the indentation, line endings and BOM the file came with. */
export function jsonText(value: unknown, indent: string | number = 2, eol: string = '\n', bom = false): string {
  let text = JSON.stringify(value, null, indent) + '\n';
  if (eol !== '\n') text = text.replace(/\n/g, eol);
  return (bom ? '﻿' : '') + text;
}

/**
 * Read, change, write a JSON object file, merging again when somebody else
 * wrote it in between (three tries). `change` returns false to write nothing.
 */
export function updateJsonFile(
  file: string,
  change: (value: Record<string, any>, existed: boolean) => boolean,
  opts: { backup?: boolean } = {},
): { ok: true; changed: boolean; backup: string | null } | { ok: false; error: string } {
  for (let attempt = 0; ; attempt++) {
    const read = readJsonObject(file);
    if (!read.ok) return read;
    const value = read.value ?? {};
    let changed: boolean;
    try {
      changed = change(value, read.value !== null);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    if (!changed) return { ok: true, changed: false, backup: null };
    try {
      const backup = writeGuarded(file, jsonText(value, read.indent, read.eol, read.bom),
        { expectHash: read.hash, backup: opts.backup });
      return { ok: true, changed: true, backup };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === FILE_CHANGED && attempt < 2) continue;
      return { ok: false, error: (e as Error).message };
    }
  }
}
