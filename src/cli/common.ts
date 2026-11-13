// ─── Shared pieces of the export / import / view / serve commands ──
//
// Small on purpose: argument parsing, path containment, tokens and the two
// checks every local HTTP listener of this package makes (Host header and
// bearer token). Nothing here reads or writes the brain.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';

// ─── Arguments ───────────────────────────────────────────────────

export type FlagKind = 'boolean' | 'string' | 'number' | 'list';
export type FlagSpec = Record<string, FlagKind>;

export interface ParsedArgs {
  flags: Record<string, string | boolean | number | string[] | undefined>;
  positionals: string[];
  errors: string[];
}

/**
 * `--name value`, `--name=value` and bare `--flag`. Unknown flags are an
 * error, never ignored: a typo in `--include-retired` must not export less
 * than the user asked for and say nothing.
 */
export function parseArgs(argv: string[], spec: FlagSpec): ParsedArgs {
  const flags: ParsedArgs['flags'] = {};
  const positionals: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { flags['help'] = true; continue; }
    if (!a.startsWith('--')) { positionals.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const kind = spec[name] ?? (name === 'help' ? 'boolean' : undefined);
    if (!kind) { errors.push(`unknown option --${name}`); continue; }
    if (kind === 'boolean') {
      if (eq !== -1) errors.push(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    let value: string | undefined = eq === -1 ? argv[i + 1] : a.slice(eq + 1);
    if (eq === -1) {
      if (value === undefined || value.startsWith('--')) { errors.push(`--${name} needs a value`); continue; }
      i++;
    }
    if (kind === 'number') {
      const n = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(n)) { errors.push(`--${name} must be a whole number`); continue; }
      flags[name] = n;
    } else if (kind === 'list') {
      const list = (flags[name] as string[] | undefined) ?? [];
      list.push(value);
      flags[name] = list;
    } else {
      flags[name] = value;
    }
  }
  return { flags, positionals, errors };
}

// ─── Paths ───────────────────────────────────────────────────────

/** The real path of `p`, or of its nearest existing ancestor plus the rest. Follows links and junctions. */
export async function realpathNearest(p: string): Promise<string> {
  let current = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/** Is `child` the same folder as `parent`, or inside it? Case-insensitive where the file system is. */
export function isInside(child: string, parent: string): boolean {
  const norm = (s: string) => (process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s);
  const rel = path.relative(norm(path.resolve(parent)), norm(path.resolve(child)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * A file name from free text (a domain, a neuron id): letters, digits, dot,
 * dash and underscore only, never `.`/`..`, never empty, at most 120 chars.
 * Everything a note is called goes through here, so no part of the brain can
 * steer a write outside the export folder.
 */
export function safeFileName(raw: string, fallback = 'untitled'): string {
  let s = String(raw ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^[._]+/, '').slice(0, 120);
  s = s.replace(/[. ]+$/, '');
  if (!s || s === '.' || s === '..') s = fallback;
  // Windows reserved device names are not valid file names on any drive.
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = `_${s}`;
  return s;
}

// ─── Tokens and HTTP guards ──────────────────────────────────────

/** 32 random bytes, hex: no character a shell, a URL or a header has to escape. */
export function randomToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Constant-time comparison of a presented secret with the expected one.
 * Both sides are hashed first so the lengths always match and the time does
 * not depend on how many leading characters were right.
 */
export function tokenMatches(presented: string | undefined | null, expected: string): boolean {
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 4096) return false;
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** The bearer value of an Authorization header, or null. */
export function bearerOf(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer[ ]+([^\s]+)\s*$/i.exec(header);
  return m ? m[1] : null;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** The Host header values a loopback listener on `port` accepts. Anything else is a DNS-rebinding attempt or a mistake. */
export function loopbackHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

export function hostAllowed(hostHeader: string | undefined, allowed: Iterable<string>): boolean {
  if (typeof hostHeader !== 'string' || !hostHeader) return false;
  const h = hostHeader.trim().toLowerCase();
  for (const a of allowed) if (a.toLowerCase() === h) return true;
  return false;
}

/** Headers every response of ours carries: nothing cached, nothing sniffed, nothing framed, no referrer. */
export const BASE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// ─── Lifetime ────────────────────────────────────────────────────

/** Resolve on Ctrl+C, SIGTERM or the abort signal, then forget the handlers. */
export function waitForStop(signal?: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      signal?.removeEventListener('abort', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop);
  });
}

// ─── Browser ─────────────────────────────────────────────────────

/** Open a URL in the default browser. Best effort: the URL is printed anyway. */
export function openBrowser(url: string): void {
  try {
    const opts = { detached: true, stdio: 'ignore' as const, windowsHide: true };
    const child = process.platform === 'win32'
      ? spawn('rundll32', ['url.dll,FileProtocolHandler', url], opts)
      : process.platform === 'darwin'
        ? spawn('open', [url], opts)
        : spawn('xdg-open', [url], opts);
    child.on('error', () => undefined);
    child.unref();
  } catch { /* printed URL is the fallback */ }
}
