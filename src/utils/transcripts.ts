// ─── Claude Code transcripts, read without reading them ─────────
//
// `crbro usage` and `crbro postmortem` both walk the session logs Claude Code
// keeps on disk. This is the one reader they share, and it is built around two
// facts about those files:
//
//   1. They are big. A long session with workflows writes 200–300 MB into a
//      single .jsonl, and one line can hold a whole tool result. So nothing here
//      loads a file: lines are cut from a byte stream, a line longer than
//      `maxLineBytes` is skipped without ever being assembled, and a caller can
//      say which bytes a line must contain before it is decoded or parsed at
//      all — most lines are thrown away as raw bytes.
//   2. They are private. Each caller decides which fields it touches; this
//      module never looks inside an entry. A torn last line (the session is
//      still writing) or a foreign line is counted and skipped, never fatal.
//
// Layout, as found under ~/.claude/projects on a real machine (2026-10):
//
//   <projects>/<project>/<session>.jsonl                                  the session
//   <projects>/<project>/<session>/subagents/agent-<id>.jsonl             Task subagents
//   <projects>/<project>/<session>/subagents/workflows/<wf>/agent-<id>.jsonl   workflow agents
//
// <project> is the working folder with every character that is not a letter or
// a digit turned into "-" (C:\Users\me\repo → C--Users-me-repo).
// CLAUDE_CONFIG_DIR, when set, moves ~/.claude and is honoured.

import { createReadStream, promises as fs } from 'fs';
import path from 'path';
import os from 'os';

/** Where Claude Code keeps its per-project session logs. */
export function claudeProjectsRoot(): string {
  const base = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/** The folder name Claude Code uses for a working directory. */
export function encodeProjectDir(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, '-');
}

export interface SessionFiles {
  /** Encoded project folder name, as on disk. */
  project: string;
  sessionId: string;
  /** The session's own log, or null when only subagent logs survive. */
  main: string | null;
  /** Every subagent and workflow-agent log under <session>/subagents/. */
  subagents: string[];
  /** Newest modification time among all of the above. */
  mtimeMs: number;
  /** Total size on disk of all of the above. */
  bytes: number;
}

export interface FindOptions {
  /** Defaults to claudeProjectsRoot(). */
  root?: string;
  /** Only sessions with a file modified in the last N days. */
  days?: number;
  /** Session id, or a prefix of it (case-insensitive). */
  session?: string;
  /** A working folder or part of the encoded folder name. */
  project?: string;
}

/** Deep enough for subagents/workflows/<wf>/agent-*.jsonl, and no deeper. */
const SUBAGENT_MAX_DEPTH = 4;

async function listJsonl(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > SUBAGENT_MAX_DEPTH) return;
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await listJsonl(p, depth + 1, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
}

function projectMatches(dirName: string, filter: string): boolean {
  const name = dirName.toLowerCase();
  const raw = filter.trim().toLowerCase();
  if (!raw) return true;
  const encoded = encodeProjectDir(filter.trim()).toLowerCase();
  return name === encoded || name.includes(raw) || name.includes(encoded);
}

/**
 * The sessions on disk that match, newest first. Only directory listings and
 * stat() — no file is opened.
 */
export async function findSessions(opts: FindOptions = {}): Promise<SessionFiles[]> {
  const root = opts.root ?? claudeProjectsRoot();
  const cutoff = opts.days !== undefined && opts.days > 0 ? Date.now() - opts.days * 86_400_000 : -Infinity;
  const wanted = opts.session?.trim().toLowerCase();

  let projects: import('fs').Dirent[];
  try {
    projects = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: SessionFiles[] = [];
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    if (opts.project && !projectMatches(p.name, opts.project)) continue;
    const projectDir = path.join(root, p.name);
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const ids = new Set<string>();
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) ids.add(e.name.slice(0, -'.jsonl'.length));
      else if (e.isDirectory()) ids.add(e.name);
    }
    for (const sessionId of ids) {
      if (wanted && !sessionId.toLowerCase().startsWith(wanted)) continue;
      const mainPath = path.join(projectDir, `${sessionId}.jsonl`);
      const subagents: string[] = [];
      await listJsonl(path.join(projectDir, sessionId, 'subagents'), 0, subagents);
      let main: string | null = null;
      let mtimeMs = 0;
      let bytes = 0;
      try {
        const st = await fs.stat(mainPath);
        if (st.isFile()) {
          main = mainPath;
          mtimeMs = st.mtimeMs;
          bytes += st.size;
        }
      } catch { /* subagents only, or not a session folder at all */ }
      if (!main && subagents.length === 0) continue;   // e.g. a memory/ or tool-results/ folder
      for (const f of subagents) {
        try {
          const st = await fs.stat(f);
          mtimeMs = Math.max(mtimeMs, st.mtimeMs);
          bytes += st.size;
        } catch { /* vanished between listing and stat */ }
      }
      if (mtimeMs < cutoff) continue;
      subagents.sort();
      out.push({ project: p.name, sessionId, main, subagents, mtimeMs, bytes });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ─── Line reader ─────────────────────────────────────────────────

export interface ReadStats {
  /** Lines seen, including skipped ones. */
  lines: number;
  /** Lines that passed the byte filter but were not valid JSON (torn, foreign). */
  broken: number;
  /** Lines longer than maxLineBytes, skipped without being assembled. */
  oversized: number;
}

export function newReadStats(): ReadStats {
  return { lines: 0, broken: 0, oversized: 0 };
}

export interface ReadOptions {
  /** A line longer than this is skipped as it streams past. Default 16 MB. */
  maxLineBytes?: number;
  /**
   * Decode and parse a line only if its raw bytes contain at least one of
   * these strings. Cheap, and it keeps most of a transcript as bytes nobody
   * looks at. The caller still checks the parsed fields: this is a pre-filter.
   */
  anyOf?: string[];
  /** Counters, filled in as the file is read. */
  stats?: ReadStats;
}

export const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * Parsed JSONL entries with their 1-based line number. Streams the file in
 * 1 MB chunks; memory stays bounded by the longest accepted line.
 */
export async function* readJsonl(
  file: string,
  opts: ReadOptions = {}
): AsyncGenerator<{ line: number; entry: any }> {
  const max = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const stats = opts.stats ?? newReadStats();
  const needles = (opts.anyOf ?? []).map(s => Buffer.from(s, 'utf8'));

  let parts: Buffer[] = [];
  let partLen = 0;
  let skipping = false;
  let lineNo = 0;

  const take = (buf: Buffer): { line: number; entry: any } | null => {
    if (needles.length && !needles.some(n => buf.includes(n))) return null;
    let text = buf.toString('utf8');
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (!text.trim()) return null;
    try {
      return { line: lineNo, entry: JSON.parse(text) };
    } catch {
      stats.broken++;
      return null;
    }
  };

  const stream = createReadStream(file, { highWaterMark: 1 << 20 });
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let start = 0;
      while (start < chunk.length) {
        const nl = chunk.indexOf(10, start);
        if (nl === -1) {
          if (!skipping) {
            const piece = chunk.subarray(start);
            if (partLen + piece.length > max) {
              skipping = true;
              parts = [];
              partLen = 0;
            } else {
              parts.push(piece);
              partLen += piece.length;
            }
          }
          break;
        }
        lineNo++;
        stats.lines++;
        if (skipping) {
          skipping = false;
          stats.oversized++;
        } else {
          const piece = chunk.subarray(start, nl);
          if (partLen + piece.length > max) {
            stats.oversized++;
          } else {
            const r = take(parts.length ? Buffer.concat([...parts, piece]) : piece);
            if (r) yield r;
          }
        }
        parts = [];
        partLen = 0;
        start = nl + 1;
      }
    }
  } finally {
    stream.destroy();
  }
  // A last line with no newline: usually the session is still writing it.
  if (skipping) {
    lineNo++;
    stats.lines++;
    stats.oversized++;
  } else if (partLen > 0) {
    lineNo++;
    stats.lines++;
    const r = take(Buffer.concat(parts));
    if (r) yield r;
  }
}
