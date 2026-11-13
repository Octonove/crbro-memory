// ─── CRBRO Shared Memory: what comes from outside ────────────────
//
// Space names, remotes and branches come from a tool call (so possibly from
// text the model was shown); neuron directories and ops come from teammates'
// pushes. Each of them used to be joined into a path, passed to git or written
// into a neuron as it came. These checks are the one place that says what
// shapes are accepted (G1, G5, G16).

import path from 'node:path';
import { redact, secretKinds } from '../engine/secrets.js';
import type { Op } from './ops.js';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A space name is a folder under shared/: a short slug, nothing that walks. */
export const SPACE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function spaceNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || !SPACE_NAME_RE.test(name)) {
    return 'Space names are 1-64 letters, digits, "-" or "_", starting with a letter or digit (e.g. "equipo").';
  }
  if (WINDOWS_RESERVED.test(name)) return `"${name}" is a reserved device name on Windows.`;
  return null;
}

/** Throws unless `name` is a valid space name whose folder stays inside `sharedRoot`. */
export function safeSpaceDir(sharedRoot: string, name: string): string {
  const problem = spaceNameProblem(name);
  if (problem) throw new Error(`Invalid space name. ${problem}`);
  const root = path.resolve(sharedRoot);
  const dir = path.resolve(root, name);
  const rel = path.relative(root, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep) || rel.includes('/')) {
    throw new Error('Invalid space name: it must name a folder directly inside shared/.');
  }
  return dir;
}

/**
 * A remote: a git URL or a local path. Never an option ("-…"), never with a
 * password or token inside (it would be stored in .git/config in clear and
 * echoed back in messages), never with control characters.
 */
export function remoteProblem(remote: unknown): string | null {
  if (typeof remote !== 'string' || !remote.trim()) return 'A remote is required.';
  if (remote.length > 2048) return 'That remote is too long.';
  if (remote.startsWith('-')) return 'A remote cannot start with "-".';
  if (/[\u0000-\u001f\u007f]/.test(remote)) return 'A remote cannot contain control characters.';
  const url = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(remote);
  if (url) {
    const scheme = url[1].toLowerCase();
    const authority = url[2];
    const at = authority.lastIndexOf('@');
    if (at !== -1) {
      const userinfo = authority.slice(0, at);
      if (scheme === 'http' || scheme === 'https' || userinfo.includes(':')) {
        return 'The remote carries credentials (user:password@ or token@). Remove them: use an SSH URL or a credential helper. ' +
          'A URL with a credential would be written in clear to .git/config.';
      }
    }
  }
  if (secretKinds(remote).length > 0) return 'The remote looks like it contains a credential. Remove it from the URL.';
  return null;
}

/** git check-ref-format rules, the subset a branch name here needs. */
export function branchProblem(branch: unknown): string | null {
  if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch) ||
      branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.') ||
      branch.endsWith('.lock') || branch.includes('@{') || /\/\./.test(branch)) {
    return 'Branch names are letters, digits, ".", "_", "-" or "/", starting with a letter or digit (e.g. "main").';
  }
  return null;
}

/** A neuron folder name in a space: what CRBRO itself would have written. */
export const NEURON_DIR_RE = /^[a-z0-9][a-z0-9_-]{0,159}$/;

const KNOWN_OPS = new Set(['neuron', 'fact', 'status', 'decision', 'pattern', 'tag', 'error', 'map', 'purge', 'debt', 'verify']);
const NEURON_TYPES = new Set(['project', 'tech', 'lang', 'person', 'domain', 'process', 'protocol']);
const MAX_TEXT = 20_000;
const MAX_ID = 128;

function cleanText(v: unknown, max = MAX_TEXT): string | null {
  if (typeof v !== 'string') return null;
  return redact(v.length > max ? v.slice(0, max) : v).text;
}

function cleanId(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID ? v : null;
}

/** Same charset as getIdentity, 32 characters: `by` ends up in `origin` labels. */
export function cleanAuthor(v: unknown): string {
  const s = typeof v === 'string' ? v.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) : '';
  return s || 'unknown';
}

/**
 * Ops read from a teammate's log for the folder `nid`, made safe to merge:
 * an op that names another neuron is dropped (the folder decides, so a planted
 * `nid` cannot steer where a neuron is written); text is capped and passed
 * through the secret filter; authors, ids, confidences and kinds are checked.
 * Returns the ops kept and how many were dropped.
 */
export function sanitizeIncomingOps(nid: string, ops: Op[]): { ops: Op[]; dropped: number } {
  const out: Op[] = [];
  let dropped = 0;
  for (const raw of ops) {
    const op = raw as unknown as Record<string, unknown>;
    if (!op || typeof op !== 'object' || op['nid'] !== nid || typeof op['op'] !== 'string' || !KNOWN_OPS.has(op['op'])) {
      dropped++;
      continue;
    }
    const at = typeof op['at'] === 'string' && op['at'].length <= 40 ? op['at'] : '';
    const base = { ...op, nid, by: cleanAuthor(op['by']), at };
    let kept: Record<string, unknown> | null = null;

    switch (op['op']) {
      case 'neuron': {
        const name = cleanText(op['name'], 200);
        kept = {
          ...base,
          name: name ?? nid,
          ntype: typeof op['ntype'] === 'string' && NEURON_TYPES.has(op['ntype']) ? op['ntype'] : 'project',
          domain: typeof op['domain'] === 'string' ? op['domain'].toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 60) || 'general' : 'general',
        };
        break;
      }
      case 'fact': {
        const text = cleanText(op['text']);
        const fid = cleanId(op['fid']);
        if (text === null || !fid) break;
        const conf = typeof op['conf'] === 'number' && Number.isFinite(op['conf']) ? Math.min(1, Math.max(0, op['conf'])) : 1;
        const keys = Array.isArray(op['keys'])
          ? op['keys'].filter((k): k is string => typeof k === 'string').slice(0, 8).map(k => redact(k.slice(0, 120)).text)
          : undefined;
        kept = { ...base, text, fid, conf, ...(keys ? { keys } : {}),
          ...(typeof op['src'] === 'string' ? { src: op['src'].slice(0, 60) } : {}) };
        if (!keys) delete kept['keys'];
        break;
      }
      case 'status': {
        const fid = cleanId(op['fid']);
        if (!fid || (op['to'] !== 'superseded' && op['to'] !== 'retracted')) break;
        const why = op['why'] === undefined ? undefined : cleanText(op['why'], 2_000) ?? undefined;
        kept = { ...base, fid, why };
        if (why === undefined) delete kept['why'];
        break;
      }
      case 'decision': {
        const text = cleanText(op['text']);
        const did = cleanId(op['did']);
        if (text === null || !did) break;
        const why = op['why'] === undefined ? undefined : cleanText(op['why'], 4_000) ?? undefined;
        kept = { ...base, text, did, why };
        if (why === undefined) delete kept['why'];
        break;
      }
      case 'pattern': case 'tag': case 'error': case 'debt': case 'map': {
        const text = cleanText(op['text'], op['op'] === 'tag' ? 200 : MAX_TEXT);
        if (text === null) break;
        kept = { ...base, text };
        break;
      }
      case 'purge': {
        const key = cleanId(op['key']);
        if (!key) break;
        kept = { ...base, key };
        break;
      }
      case 'verify': {
        const eid = cleanId(op['eid']);
        if (!eid || (op['ekind'] !== 'fact' && op['ekind'] !== 'entry')) break;
        kept = { ...base, eid };
        break;
      }
    }

    if (kept) out.push(kept as unknown as Op);
    else dropped++;
  }
  return { ops: out, dropped };
}
