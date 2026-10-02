// ─── Post-mortem of past sessions ───────────────────────────────
//
// `crbro postmortem`: look back over recent Claude Code sessions for the
// moments that usually mean a lesson was missing — the user correcting the
// assistant again and again, the same tool failing in a row, a request that
// had to be made twice (in one session, or in two), a session that ran very
// long — and propose them as candidate lessons, each with where it was seen.
//
// Deterministic on purpose: fixed patterns and counts, no model call. It
// proposes, it never stores. Saving one is the model's job, with crbro_learn,
// after the user says yes.
//
// What is read, and what is not:
//   · user text blocks (what the person typed; harness lines such as system
//     reminders, command output or task notifications are dropped);
//   · the NAME and id of each tool the assistant called — never its input;
//   · of each tool result, only is_error and tool_use_id — never its content;
//   · timestamps and message ids, to measure the session.
// Assistant prose is not needed for any signal, so it is not read either.
// Only the main session log is read: in a subagent log the "user" is the
// orchestrating model, not the person, so its corrections are not theirs.
// Every string this module returns has been through redact().

import { redact } from './secrets.js';
import {
  claudeProjectsRoot, findSessions, readJsonl, newReadStats,
  type FindOptions, type SessionFiles, type ReadStats,
} from '../utils/transcripts.js';

export type FindingKind = 'corrections' | 'failing_tool' | 'repeated_request' | 'long_session';

export interface Evidence {
  session: string;
  line: number;
  /** Redacted, one line, at most EXCERPT_CHARS characters. Absent for tool failures. */
  text?: string;
}

export interface Finding {
  kind: FindingKind;
  project: string;
  /** The session it was seen in; for a request repeated across sessions, the newest. */
  session: string;
  score: number;
  evidence: Evidence[];
  lesson: string;
}

export interface PostmortemReport {
  root: string;
  days: number | null;
  sessions_read: number;
  findings: Finding[];
  /** Findings before --max was applied. */
  total_findings: number;
  lines_broken: number;
  lines_oversized: number;
  thresholds: typeof THRESHOLDS;
}

export const THRESHOLDS = {
  /** Corrections in one session before it is worth a look. */
  corrections: 2,
  /** The same tool failing this many times in a row. */
  toolStreak: 3,
  /** A session with this many requests from the person… */
  longUserTurns: 60,
  /** …or this many model responses, is "very long". */
  longResponses: 600,
  /** Word-set overlap for two requests to count as the same one. */
  sameRequestJaccard: 0.8,
} as const;

const EXCERPT_CHARS = 160;

// ─── What the person typed ───────────────────────────────────────

/**
 * Lines the client writes on the person's behalf. Not requests. The last one is
 * the Claude desktop app resuming after a usage limit: it arrives as a human
 * prompt with no flag, so only its wording tells it apart (seen in Spanish).
 */
export const NOT_A_REQUEST = /^(?:<local-command-|<system-reminder>|<command-stdout>|<command-message>|<bash-|<user-prompt-submit-hook>|<task-notification>|\[Request interrupted|Caveat: |Alcancé mi límite de uso mientras trabajabas)/;

/**
 * The text a person typed in one user entry, or '' when the entry is a tool
 * result, a meta line, a compaction summary or a reminder. Reads only the
 * text blocks; a tool_result block is never opened here.
 */
export function userText(entry: any): string {
  if (!entry || entry.type !== 'user' || entry.isMeta || entry.isSidechain || entry.isCompactSummary) return '';
  // A background task's notification or another agent's message: not the person.
  if (entry.origin && typeof entry.origin.kind === 'string' && entry.origin.kind !== 'human') return '';
  const content = entry.message?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((b: any) => b && b.type === 'tool_result')) return '';
    text = content.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n');
  } else return '';
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
    text = `${name[1].trim()} ${args ? args[1].trim() : ''}`.trim();
  }
  if (!text || NOT_A_REQUEST.test(text)) return '';
  return text;
}

/** Of a user entry's tool results: the id and the error flag. Nothing else. */
export function toolResults(entry: any): Array<{ id: string; isError: boolean }> {
  if (!entry || entry.type !== 'user' || entry.isSidechain) return [];
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; isError: boolean }> = [];
  for (const b of content) {
    if (b && b.type === 'tool_result') {
      out.push({ id: typeof b.tool_use_id === 'string' ? b.tool_use_id : '', isError: b.is_error === true });
    }
  }
  return out;
}

/** Of an assistant entry's tool calls: the id and the tool's name. Never the input. */
export function toolCalls(entry: any): Array<{ id: string; name: string }> {
  if (!entry || entry.type !== 'assistant' || entry.isSidechain) return [];
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; name: string }> = [];
  for (const b of content) {
    if (b && b.type === 'tool_use' && typeof b.name === 'string') {
      out.push({ id: typeof b.id === 'string' ? b.id : '', name: b.name });
    }
  }
  return out;
}

// ─── Signals ─────────────────────────────────────────────────────

/** Fixed phrases that, in Spanish or English, usually open a correction. */
export const CORRECTION_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: '«no,»', re: /^\s*no\s*[,.!;:]/i },
  { label: '«te dije»', re: /\b(?:ya\s+)?te\s+(?:lo\s+)?(?:dije|he\s+dicho|hab[ií]a\s+dicho|ped[ií]|he\s+pedido)\b/i },
  { label: '«otra vez»', re: /\botra\s+vez\b/i },
  // Only when it opens a sentence: "eso no interfiere" and "para eso no?" are not corrections.
  { label: '«eso no»', re: /(?:^|[.!?¡¿\n]\s*)eso\s+no\b/i },
  { label: '«no es eso»', re: /\bno\s+es\s+(?:eso|as[ií]|lo\s+que\s+(?:te\s+)?(?:he\s+)?ped)/i },
  { label: '«mal»', re: /^\s*mal\b|\b(?:est[aá]|lo\s+has\s+hecho|has\s+hecho|sigue|queda|sale|va)\s+mal\b/i },
  { label: "«that's wrong»", re: /\bthat'?s\s+(?:wrong|not\s+(?:it|right|what\s+i))/i },
  { label: '«I said»', re: /\bi\s+(?:said|told\s+you|already\s+(?:said|told))\b/i },
  { label: '«not what I asked»', re: /\bnot\s+what\s+i\s+(?:asked|wanted|meant)\b/i },
];

/** A correction opens the message: only its first characters are looked at. */
export const CORRECTION_WINDOW = 160;
/** Longer than this it is a brief or a scheduled prompt ("si algo sale mal…"), not a correction. */
export const CORRECTION_MAX_CHARS = 1200;

export function correctionLabel(text: string): string | null {
  if (text.length > CORRECTION_MAX_CHARS) return null;
  const opening = text.slice(0, CORRECTION_WINDOW);
  for (const p of CORRECTION_PATTERNS) if (p.re.test(opening)) return p.label;
  return null;
}

/** Redact first, then cut: a cut first could leave half a secret the filter no longer recognises. */
export function excerpt(text: string): string {
  const flat = redact(text).text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? flat.slice(0, EXCERPT_CHARS - 1) + '…' : flat;
}

function normalise(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function wordSet(norm: string): Set<string> {
  return new Set(norm.split(' ').filter(w => w.length >= 3));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Long enough to be a real request, not "sí" or "continúa". */
function repeatable(text: string, norm: string): boolean {
  return !text.startsWith('/') && norm.length >= 25 && norm.split(' ').length >= 4;
}

// ─── One session ─────────────────────────────────────────────────

interface Seen {
  session: string; project: string; line: number; text: string; uuid: string;
  /** It was the first thing typed in its session. */
  opening: boolean;
}

interface SessionScan {
  findings: Finding[];
  /** Exact normalised requests of this session, for the cross-session check. */
  requests: Map<string, Seen>;
}

/** How many recent requests a new one is compared with for near-repeats. */
const NEAR_WINDOW = 40;

/** A pause longer than this is a break, not time spent in the session. */
const IDLE_GAP_MS = 30 * 60_000;

async function scanSession(s: SessionFiles, stats: ReadStats): Promise<SessionScan> {
  const findings: Finding[] = [];
  const requests = new Map<string, Seen>();
  if (!s.main) return { findings, requests };

  const toolName = new Map<string, string>();
  const responses = new Set<string>();
  let responsesNoId = 0;
  let userTurns = 0;
  let first = '';
  let last = '';
  // Active time, not first-to-last: a session resumed over weeks is not weeks long.
  let activeMs = 0;
  let prevMs = NaN;
  let toolsSinceUser: string[] = [];

  const corrections: Array<{ line: number; text: string; label: string; tools: string[] }> = [];
  let streak: { name: string; lines: number[] } | null = null;
  const streaks: Array<{ name: string; lines: number[] }> = [];
  const closeStreak = () => {
    if (streak && streak.lines.length >= THRESHOLDS.toolStreak) streaks.push(streak);
    streak = null;
  };
  const groups: Array<{ lines: number[]; text: string }> = [];
  const exact = new Map<string, number>();
  const recent: Array<{ words: Set<string>; group: number }> = [];

  for await (const { line, entry } of readJsonl(s.main, { anyOf: ['"type":"user"', '"type":"assistant"'], stats })) {
    if (!entry || entry.isSidechain) continue;
    if (typeof entry.timestamp === 'string') {
      if (!first) first = entry.timestamp;
      last = entry.timestamp;
      const ms = Date.parse(entry.timestamp);
      if (Number.isFinite(ms)) {
        const gap = ms - prevMs;
        if (gap > 0 && gap <= IDLE_GAP_MS) activeMs += gap;
        prevMs = ms;
      }
    }
    if (entry.type === 'assistant') {
      const id = entry.message?.id;
      if (typeof id === 'string') responses.add(id); else responsesNoId++;
      for (const c of toolCalls(entry)) {
        if (c.id) toolName.set(c.id, c.name);
        if (!toolsSinceUser.includes(c.name) && toolsSinceUser.length < 5) toolsSinceUser.push(c.name);
      }
      continue;
    }
    if (entry.type !== 'user') continue;

    const results = toolResults(entry);
    if (results.length) {
      for (const r of results) {
        const name = toolName.get(r.id) ?? 'desconocida';
        toolName.delete(r.id);
        if (r.isError) {
          if (streak && streak.name === name) streak.lines.push(line);
          else { closeStreak(); streak = { name, lines: [line] }; }
        } else {
          closeStreak();
        }
      }
      continue;
    }

    const text = userText(entry);
    if (!text) continue;
    userTurns++;
    const label = correctionLabel(text);
    if (label) corrections.push({ line, text: excerpt(text), label, tools: toolsSinceUser });
    toolsSinceUser = [];

    const norm = normalise(text);
    if (repeatable(text, norm)) {
      const key = norm.slice(0, 300);
      if (!requests.has(key)) {
        const uuid = typeof entry.uuid === 'string' ? entry.uuid : '';
        requests.set(key, { session: s.sessionId, project: s.project, line, text: excerpt(text), uuid, opening: userTurns === 1 });
      }
      let g = exact.get(key);
      const words = wordSet(norm);
      if (g === undefined && words.size >= 5) {
        for (const r of recent) {
          if (r.words.size >= 5 && jaccard(words, r.words) >= THRESHOLDS.sameRequestJaccard) { g = r.group; break; }
        }
      }
      if (g === undefined) {
        g = groups.length;
        groups.push({ lines: [], text: excerpt(text) });
      }
      groups[g].lines.push(line);
      exact.set(key, g);
      recent.push({ words, group: g });
      if (recent.length > NEAR_WINDOW) recent.shift();
    }
  }
  closeStreak();

  const base = { project: s.project, session: s.sessionId };
  if (corrections.length >= THRESHOLDS.corrections) {
    const clearest = corrections.find(c => c.label !== '«no,»') ?? corrections[0];
    const tools = clearest.tools.length ? `, right after using ${clearest.tools.join(', ')}` : '';
    findings.push({
      ...base,
      kind: 'corrections',
      score: corrections.length * 3,
      evidence: corrections.slice(0, 5).map(c => ({ session: s.sessionId, line: c.line, text: c.text })),
      lesson: `The user corrected ${corrections.length} times in this session. Candidate lesson: what the clearest correction asks for («${clearest.text}»${tools}).`,
    });
  }
  for (const st of streaks) {
    findings.push({
      ...base,
      kind: 'failing_tool',
      score: st.lines.length * 2,
      evidence: st.lines.slice(0, 5).map(l => ({ session: s.sessionId, line: l })),
      lesson: `${st.name} failed ${st.lines.length} times in a row (lines ${st.lines[0]}–${st.lines[st.lines.length - 1]}). Candidate lesson: what was wrong with the first call, so it is not repeated blindly.`,
    });
  }
  for (const g of groups) {
    if (g.lines.length < 2) continue;
    findings.push({
      ...base,
      kind: 'repeated_request',
      score: g.lines.length * 2,
      evidence: g.lines.slice(0, 5).map(l => ({ session: s.sessionId, line: l, text: g.text })),
      lesson: `The same request appears ${g.lines.length} times in the session («${g.text}»). Candidate lesson: why the first answer was not enough.`,
    });
  }
  const nResponses = responses.size + responsesNoId;
  if (userTurns >= THRESHOLDS.longUserTurns || nResponses >= THRESHOLDS.longResponses) {
    const days = first && last ? Math.floor((Date.parse(last) - Date.parse(first)) / 86_400_000) + 1 : NaN;
    const span = Number.isFinite(days)
      ? ` in ${(activeMs / 3_600_000).toFixed(1)} h of activity${days > 1 ? ` spread over ${days} days` : ''}`
      : '';
    findings.push({
      ...base,
      kind: 'long_session',
      score: 1 + Math.max(userTurns / THRESHOLDS.longUserTurns, nResponses / THRESHOLDS.longResponses),
      evidence: [{ session: s.sessionId, line: 1 }],
      lesson: `Very long session: ${userTurns} requests and ${nResponses} responses${span}. Candidate lesson: at which point it was worth closing with crbro_consolidate and going on in a new session.`,
    });
  }
  return { findings, requests };
}

// ─── All of them ─────────────────────────────────────────────────

export interface PostmortemOptions extends FindOptions {
  /** Findings to return, strongest first. Default 10. */
  max?: number;
}

function redactDeep<T>(v: T): T {
  if (typeof v === 'string') return redact(v).text as unknown as T;
  if (Array.isArray(v)) return v.map(redactDeep) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = redactDeep(x);
    return out as T;
  }
  return v;
}

export async function runPostmortem(opts: PostmortemOptions = {}): Promise<PostmortemReport> {
  const root = opts.root ?? claudeProjectsRoot();
  const sessions = await findSessions({ ...opts, root });
  const stats = newReadStats();
  let findings: Finding[] = [];
  const across = new Map<string, { seen: Seen[]; sessions: number; allOpening: boolean }>();
  let read = 0;

  for (const s of sessions) {
    if (!s.main) continue;
    read++;
    let scan: SessionScan;
    try {
      scan = await scanSession(s, stats);
    } catch {
      continue;   // unreadable: skipped, not fatal
    }
    findings.push(...scan.findings);
    for (const [key, seen] of scan.requests) {
      const acc = across.get(key) ?? { seen: [], sessions: 0, allOpening: true };
      // A resumed or forked session can carry the earlier messages over with
      // their ids: the same message twice is a copy, not the person asking again.
      if (seen.uuid && acc.seen.some(x => x.uuid === seen.uuid)) continue;
      if (acc.seen.length < 5) acc.seen.push(seen);
      acc.sessions++;
      acc.allOpening &&= seen.opening;
      across.set(key, acc);
    }
  }

  for (const { seen: list, sessions, allOpening } of across.values()) {
    if (sessions < 2) continue;
    // Sessions come newest first, so list[0] is the latest time it was asked.
    // The very same opening line in several sessions is most often a scheduled
    // task or a saved template: worth a mention, ranked below the rest.
    findings.push({
      kind: 'repeated_request',
      project: list[0].project,
      session: list[0].session,
      score: allOpening ? 1 + Math.min(sessions, 10) / 10 : sessions * 2 + 2,
      evidence: list.map(x => ({ session: x.session, line: x.line, text: x.text })),
      lesson: allOpening
        ? `The same request opens ${sessions} different sessions («${list[0].text}»). If it is a scheduled task or a template there is no lesson; if it is typed by hand each time, what it asks for can be stored in CRBRO.`
        : `The same request was made in ${sessions} different sessions («${list[0].text}»). Candidate lesson: store the answer or the procedure in CRBRO, so it does not have to be asked again.`,
    });
  }

  findings.sort((a, b) => b.score - a.score);
  const total = findings.length;
  const max = opts.max !== undefined && opts.max > 0 ? opts.max : 10;
  findings = findings.slice(0, max);

  return redactDeep({
    root,
    days: opts.days ?? null,
    sessions_read: read,
    findings,
    total_findings: total,
    lines_broken: stats.broken,
    lines_oversized: stats.oversized,
    thresholds: THRESHOLDS,
  });
}

// ─── Text output ────────────────────────────────────────────────

const KIND_LABEL: Record<FindingKind, string> = {
  corrections: 'Repeated corrections',
  failing_tool: 'The same tool failing in a row',
  repeated_request: 'The same request repeated',
  long_session: 'Very long session',
};

export function formatPostmortem(r: PostmortemReport): string {
  const L: string[] = [];
  const period = r.days ? `last ${r.days} days` : 'all history';
  L.push('');
  L.push(`  Post-mortem — ${period} · ${r.sessions_read} sessions read`);
  L.push('  Only the user messages and the names of the tools are read; tool results are never');
  L.push('  opened. Everything quoted goes through the secret filter.');
  L.push('');
  if (r.findings.length === 0) {
    L.push('  No signal above the thresholds. Nothing to propose.');
    L.push('');
    return L.join('\n');
  }
  L.push(`  ${r.findings.length === r.total_findings ? r.findings.length : `${r.findings.length} of ${r.total_findings}`} candidate lessons, strongest first:`);
  r.findings.forEach((f, i) => {
    L.push('');
    L.push(`  ${i + 1}. ${KIND_LABEL[f.kind]} · ${f.project}`);
    L.push(`     ${f.lesson}`);
    for (const e of f.evidence) {
      L.push(`       - session ${e.session.slice(0, 8)} · line ${e.line}${e.text ? `: «${e.text}»` : ''}`);
    }
  });
  if (r.lines_broken || r.lines_oversized) {
    L.push('');
    L.push(`  Lines skipped: ${r.lines_broken} unreadable, ${r.lines_oversized} too long.`);
  }
  L.push('');
  L.push('  Nothing has been saved. These are candidates: to store one, the model proposes it to the');
  L.push('  user and only after a yes uses crbro_learn.');
  L.push('');
  return L.join('\n');
}
