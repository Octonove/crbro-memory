// ─── Token spend, from metadata only ────────────────────────────
//
// `crbro usage`: how many tokens each model took, per session, with the main
// conversation and its subagents kept apart. A workflow that fans out to a
// dozen agents can cost more than the conversation that launched it, and that
// is invisible from inside the conversation.
//
// Privacy contract: of each transcript line this reads message.model,
// message.usage, message.id, requestId, isSidechain and timestamp — nothing else. The
// content of the conversation is never touched, and lines that cannot carry a
// usage block are dropped as raw bytes before they are even decoded.
//
// One API response is written as several lines (one per content block), each
// repeating the same message.id and usage, with output_tokens growing until the
// last one. Summing lines would count a response three or four times, so lines
// are merged per message id, keeping the largest value of each counter.
//
// A resumed or forked session copies the earlier responses into its own .jsonl
// with the same message.id and usage. So the merge is report-wide, not
// per-session: the oldest session that holds a response is charged for it and
// every later copy is skipped.
//
// With --days, a response is counted only if its own timestamp is inside the
// window: a long session resumed today does not bring weeks of spend with it.
//
// No prices: they change, differ by plan and are not in the transcript. This
// counts tokens and says so.

import { claudeProjectsRoot, findSessions, readJsonl, newReadStats, type FindOptions, type SessionFiles, type ReadStats } from '../utils/transcripts.js';

export interface TokenCounts {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** API responses, after merging the lines of each one. */
  messages: number;
}

export type ByModel = Record<string, TokenCounts>;

export interface SessionUsage {
  project: string;
  session: string;
  last_activity: string;
  main: ByModel;
  subagents: ByModel;
  subagent_files: number;
}

export interface UsageReport {
  root: string;
  days: number | null;
  sessions: SessionUsage[];
  by_model: Record<string, { main: TokenCounts; subagents: TokenCounts; total: TokenCounts }>;
  totals: { main: TokenCounts; subagents: TokenCounts; total: TokenCounts };
  files_read: number;
  lines_broken: number;
  lines_oversized: number;
}

const FIELDS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const;

export function zeroCounts(): TokenCounts {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, messages: 0 };
}

export function tokenTotal(c: TokenCounts): number {
  return c.input_tokens + c.output_tokens + c.cache_creation_input_tokens + c.cache_read_input_tokens;
}

function add(into: TokenCounts, c: TokenCounts): void {
  for (const f of FIELDS) into[f] += c[f];
  into.messages += c.messages;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

export interface UsagePick {
  /** message.id, else requestId; null when the line has neither. */
  key: string | null;
  model: string;
  sidechain: boolean;
  /** entry.timestamp in ms, or null when missing or unparseable. */
  at: number | null;
  counts: Omit<TokenCounts, 'messages'>;
}

/**
 * The only function that looks at a transcript entry for `usage`, and the only
 * fields it reads. Anything else in the entry, the content above all, is
 * never accessed.
 */
export function pickUsage(entry: any): UsagePick | null {
  if (!entry || typeof entry !== 'object' || entry.type !== 'assistant') return null;
  const message = entry.message;
  if (!message || typeof message !== 'object') return null;
  const usage = message.usage;
  if (!usage || typeof usage !== 'object') return null;
  const model = typeof message.model === 'string' && message.model ? message.model : 'unknown';
  const id = typeof message.id === 'string' && message.id ? message.id
    : typeof entry.requestId === 'string' && entry.requestId ? entry.requestId : null;
  const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  return {
    key: id,
    model,
    sidechain: entry.isSidechain === true,
    at: Number.isFinite(at) ? at : null,
    counts: {
      input_tokens: num(usage.input_tokens),
      output_tokens: num(usage.output_tokens),
      cache_creation_input_tokens: num(usage.cache_creation_input_tokens),
      cache_read_input_tokens: num(usage.cache_read_input_tokens),
    },
  };
}

interface Merged { model: string; role: 'main' | 'subagents'; counts: Omit<TokenCounts, 'messages'> }

/** A line that carries a usage block contains this key, unescaped. */
const USAGE_NEEDLE = '"usage"';

/**
 * `claimed`: response keys already charged to an older session of this report.
 * `cutoff`: responses timestamped before it are left out (-Infinity = no window).
 */
async function sessionUsage(
  s: SessionFiles, stats: ReadStats, claimed: Set<string>, cutoff: number,
): Promise<{ usage: SessionUsage; files: number }> {
  const merged = new Map<string, Merged>();
  let files = 0;
  const toRead: Array<{ file: string; role: 'main' | 'subagents' }> = [];
  if (s.main) toRead.push({ file: s.main, role: 'main' });
  for (const f of s.subagents) toRead.push({ file: f, role: 'subagents' });

  for (const { file, role } of toRead) {
    files++;
    try {
      for await (const { line, entry } of readJsonl(file, { anyOf: [USAGE_NEEDLE], stats })) {
        const u = pickUsage(entry);
        if (!u) continue;
        // "<synthetic>": a message the client wrote itself (an API error, an
        // interruption). No request, no tokens.
        if (u.model.startsWith('<') && FIELDS.every(f => u.counts[f] === 0)) continue;
        if (u.at !== null && u.at < cutoff) continue;
        const key = u.key ?? `${file}#${line}`;
        if (claimed.has(key)) continue;
        const r: 'main' | 'subagents' = role === 'main' && !u.sidechain ? 'main' : 'subagents';
        const prev = merged.get(key);
        if (!prev) {
          merged.set(key, { model: u.model, role: r, counts: { ...u.counts } });
        } else {
          for (const f of FIELDS) prev.counts[f] = Math.max(prev.counts[f], u.counts[f]);
        }
      }
    } catch { /* unreadable file: counted as read, contributes nothing */ }
  }
  for (const key of merged.keys()) claimed.add(key);

  const main: ByModel = {};
  const subagents: ByModel = {};
  for (const m of merged.values()) {
    const bucket = m.role === 'main' ? main : subagents;
    const c = bucket[m.model] ??= zeroCounts();
    add(c, { ...m.counts, messages: 1 });
  }
  return {
    usage: {
      project: s.project,
      session: s.sessionId,
      last_activity: new Date(s.mtimeMs).toISOString(),
      main,
      subagents,
      subagent_files: s.subagents.length,
    },
    files,
  };
}

export interface UsageOptions extends FindOptions {}

export async function collectUsage(opts: UsageOptions = {}): Promise<UsageReport> {
  const root = opts.root ?? claudeProjectsRoot();
  const sessions = await findSessions({ ...opts, root });
  const stats = newReadStats();
  const report: UsageReport = {
    root,
    days: opts.days ?? null,
    sessions: [],
    by_model: {},
    totals: { main: zeroCounts(), subagents: zeroCounts(), total: zeroCounts() },
    files_read: 0,
    lines_broken: 0,
    lines_oversized: 0,
  };
  const cutoff = opts.days !== undefined && opts.days > 0 ? Date.now() - opts.days * 86_400_000 : -Infinity;
  // Oldest first, so a response copied into a resumed session is charged to
  // the session where it happened. The report keeps findSessions' order.
  const claimed = new Set<string>();
  const found: SessionUsage[] = [];
  for (const s of [...sessions].reverse()) {
    const { usage, files } = await sessionUsage(s, stats, claimed, cutoff);
    report.files_read += files;
    if (Object.keys(usage.main).length === 0 && Object.keys(usage.subagents).length === 0) continue;
    found.push(usage);
  }
  for (const usage of found.reverse()) {
    report.sessions.push(usage);
    for (const role of ['main', 'subagents'] as const) {
      for (const [model, c] of Object.entries(usage[role])) {
        const m = report.by_model[model] ??= { main: zeroCounts(), subagents: zeroCounts(), total: zeroCounts() };
        add(m[role], c);
        add(m.total, c);
        add(report.totals[role], c);
        add(report.totals.total, c);
      }
    }
  }
  report.lines_broken = stats.broken;
  report.lines_oversized = stats.oversized;
  return report;
}

// ─── Text output ────────────────────────────────────────────────

export function fmt(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function sumModels(b: ByModel): TokenCounts {
  const t = zeroCounts();
  for (const c of Object.values(b)) add(t, c);
  return t;
}

function row(label: string, c: TokenCounts, w: number): string {
  const cols = [c.input_tokens, c.output_tokens, c.cache_creation_input_tokens, c.cache_read_input_tokens, c.messages]
    .map(v => fmt(v).padStart(15)).join('');
  return `  ${label.padEnd(w)}${cols}`;
}

export function formatUsage(r: UsageReport, opts: { top?: number } = {}): string {
  const top = opts.top ?? 15;
  const L: string[] = [];
  const period = r.days ? `last ${r.days} days` : 'all history';
  L.push('');
  L.push(`  Token spend — ${period} · ${r.sessions.length} sessions · ${r.files_read} files read`);
  L.push('  Metadata only (message.model and message.usage); the content of the conversations is not read.');
  L.push('  Tokens, not money: the price depends on the plan and is not in the transcript.');
  L.push('');
  if (r.sessions.length === 0) {
    L.push(`  No sessions with usage data in ${r.root} for that filter.`);
    L.push('');
    return L.join('\n');
  }
  const models = Object.keys(r.by_model).sort((a, b) => tokenTotal(r.by_model[b].total) - tokenTotal(r.by_model[a].total));
  const w = Math.max(28, ...models.map(m => m.length + 4));
  const head = ['input', 'output', 'cache write', 'cache read', 'responses'].map(h => h.padStart(15)).join('');
  L.push(`  ${'By model'.padEnd(w)}${head}`);
  for (const m of models) {
    const b = r.by_model[m];
    L.push(row(m, b.total, w));
    if (b.main.messages) L.push(row('  · main', b.main, w));
    if (b.subagents.messages) L.push(row('  · subagents', b.subagents, w));
  }
  L.push(row('Total', r.totals.total, w));
  L.push(row('  · main', r.totals.main, w));
  L.push(row('  · subagents', r.totals.subagents, w));
  L.push('');

  const weight = (s: SessionUsage) => tokenTotal(sumModels(s.main)) + tokenTotal(sumModels(s.subagents));
  const ranked = [...r.sessions].sort((a, b) => weight(b) - weight(a));
  const shown = ranked.slice(0, top);
  L.push(`  By session (${shown.length === ranked.length ? 'all' : `the ${shown.length} with most tokens of ${ranked.length}`}; --session <id> for one, --json for everything):`);
  for (const s of shown) {
    const mn = sumModels(s.main);
    const sb = sumModels(s.subagents);
    const when = s.last_activity.slice(0, 16).replace('T', ' ');
    L.push(`  ${when} UTC  ${s.session.slice(0, 8)}  ${s.project}`);
    L.push(`      main ${fmt(tokenTotal(mn))} tokens in ${fmt(mn.messages)} responses · subagents ${fmt(tokenTotal(sb))} in ${fmt(sb.messages)} (${s.subagent_files} files)`);
  }
  if (r.lines_broken || r.lines_oversized) {
    L.push('');
    L.push(`  Lines skipped: ${r.lines_broken} unreadable (e.g. the last one of a session still open), ${r.lines_oversized} too long.`);
  }
  L.push('');
  return L.join('\n');
}
