// ─── A size ceiling for anything that leaves through the wire ────
//
// Why this exists, from the field: MCP clients cap a single tool result
// (Claude Code at 25,000 tokens). A brain grows, and one day a read that
// worked for months stops arriving — in one user's transcripts, 264 dumps
// of a single neuron and 154 of the boot payload, the largest at ~132,000
// tokens for ONE call. Nothing in the server had changed; the brain had.
//
// So the ceiling lives here, at the one place every read passes through,
// instead of being re-invented per view. A view that grows a new field, or
// a view added next year, inherits it.
//
// The rule that makes this honest: nothing is cut in silence. Whatever is
// trimmed comes back described in `truncated` — how many entries exist,
// how many were returned, and the exact call that fetches the rest. A
// memory that quietly hides half of what it knows is worse than one that
// admits it is too big to send.

/** What was cut, always reported inside the payload itself. */
export interface BudgetReport {
  reason: string;
  budget_chars: number;
  original_chars: number;
  returned_chars: number;
  /** Long strings shortened, by path — each keeps its first `string_cap` chars. */
  texts_shortened?: Record<string, { returned: number; total: number }>;
  /** Arrays cut short, by path. */
  entries_dropped?: Record<string, { returned: number; total: number }>;
  how_to_get_more?: string;
}

export interface BudgetOptions {
  /** Ceiling for the serialized payload, in characters. */
  budget?: number;
  /** Strings longer than this are shortened first. */
  stringCap?: number;
  /** Told to the caller verbatim: the call that returns what was cut. */
  howToGetMore?: string;
  /** Keys never shortened or dropped, whatever the size (protocol blocks). */
  keep?: string[];
}

export const DEFAULT_BUDGET_CHARS = 24_000;
export const DEFAULT_STRING_CAP = 1_200;

const size = (v: unknown): number => {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Shorten a payload until it fits, describing every cut.
 *
 * Two passes, cheapest first:
 *   1. long strings (a session summary, a fact body) keep their opening and
 *      say how much was left behind — the opening is where the headline is;
 *   2. if that is not enough, arrays lose entries from the end, newest kept,
 *      never below one entry, largest array first.
 *
 * Returns the same object when it already fits, so the common path costs
 * one JSON.stringify and nothing else.
 */
export function fitToBudget<T>(payload: T, opts: BudgetOptions = {}): T {
  const budget = opts.budget ?? DEFAULT_BUDGET_CHARS;
  const stringCap = opts.stringCap ?? DEFAULT_STRING_CAP;
  const keep = new Set(opts.keep ?? []);

  const original = size(payload);
  if (original <= budget || !isPlainObject(payload)) return payload;

  const copy: Record<string, unknown> = structuredClone(payload) as Record<string, unknown>;
  const shortened: Record<string, { returned: number; total: number }> = {};
  const dropped: Record<string, { returned: number; total: number }> = {};

  // ── Pass 1: shorten long strings, keeping their opening ──────────
  const shortenStrings = (node: unknown, path: string): unknown => {
    if (typeof node === 'string') {
      if (node.length <= stringCap) return node;
      shortened[path || 'value'] = { returned: stringCap, total: node.length };
      return `${node.slice(0, stringCap)}… [${node.length - stringCap} more characters — see truncated]`;
    }
    if (Array.isArray(node)) return node.map((v, i) => shortenStrings(v, `${path}[${i}]`));
    if (isPlainObject(node)) {
      for (const [k, v] of Object.entries(node)) {
        if (keep.has(k)) continue;
        node[k] = shortenStrings(v, path ? `${path}.${k}` : k);
      }
      return node;
    }
    return node;
  };
  shortenStrings(copy, '');

  // ── Pass 2: drop array entries, largest array first ──────────────
  const arraysOf = (node: unknown, path: string, out: Array<{ path: string; arr: unknown[] }>) => {
    if (Array.isArray(node)) {
      out.push({ path: path || 'items', arr: node });
      node.forEach((v, i) => arraysOf(v, `${path}[${i}]`, out));
      return;
    }
    if (isPlainObject(node)) {
      for (const [k, v] of Object.entries(node)) {
        if (!keep.has(k)) arraysOf(v, path ? `${path}.${k}` : k, out);
      }
    }
  };

  let guard = 0;
  while (size(copy) > budget && guard++ < 200) {
    const found: Array<{ path: string; arr: unknown[] }> = [];
    arraysOf(copy, '', found);
    const biggest = found
      .filter(a => a.arr.length > 1)
      .sort((a, b) => size(b.arr) - size(a.arr))[0];
    if (!biggest) break;

    const total = dropped[biggest.path]?.total ?? biggest.arr.length;
    // Halve, so a very long list converges in a handful of rounds.
    const target = Math.max(1, Math.floor(biggest.arr.length / 2));
    biggest.arr.length = target;
    dropped[biggest.path] = { returned: target, total };
  }

  const report: BudgetReport = {
    reason: 'This response was larger than one tool result can carry, so it was shortened. Nothing was deleted from the brain.',
    budget_chars: budget,
    original_chars: original,
    returned_chars: size(copy),
  };
  if (Object.keys(shortened).length) {
    // One line per path is noise when a list of 40 items each lost a tail.
    report.texts_shortened = Object.keys(shortened).length > 12
      ? { total_texts: { returned: stringCap, total: Object.keys(shortened).length } }
      : shortened;
  }
  if (Object.keys(dropped).length) report.entries_dropped = dropped;
  if (opts.howToGetMore) report.how_to_get_more = opts.howToGetMore;

  copy.truncated = report;
  return copy as T;
}
