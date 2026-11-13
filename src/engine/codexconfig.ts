// ─── Codex's config.toml, edited a line at a time ────────────────
//
// Codex reads its MCP servers from <CODEX_HOME>/config.toml. CRBRO needs one
// table there, [mcp_servers.crbro], and two numbers in it: how long Codex
// waits for the server to start (startup_timeout_sec) and for a tool call
// (tool_timeout_sec). Without them a cold start — a fresh npx download, an
// index being rebuilt — runs past Codex's default and the session starts with
// no memory.
//
// There is no TOML parser in this package and none is added for this: the
// file is the user's, full of tables CRBRO has no business rewriting, and a
// parse-and-serialise round trip would reorder it, drop its comments and
// change its quoting. So this reads lines. A small scanner knows which lines
// are table headers at the top level — not inside a multi-line string or a
// multi-line array — and every change is an insertion or a removal of whole
// lines inside CRBRO's own table. What CRBRO does not recognise for sure (an
// inline `crbro = { … }`, dotted `mcp_servers.crbro.x = …` keys at the top)
// is reported and left alone. Line endings and a BOM are kept as found.

export const SERVER_NAME = 'crbro';
export const STARTUP_TIMEOUT_KEY = 'startup_timeout_sec';
export const TOOL_TIMEOUT_KEY = 'tool_timeout_sec';
export const DEFAULT_STARTUP_TIMEOUT = 60;
export const DEFAULT_TOOL_TIMEOUT = 120;

interface Line {
  text: string;
  /** Dotted table path when this line is a top-level [table] header, else null. */
  header: string[] | null;
  /** [[array of tables]] header. */
  arrayTable: boolean;
  /** key = value at the start of this line, outside any multi-line value. */
  key: string | null;
  /** Line index where the value that starts here ends (same line unless multi-line). */
  valueEnd: number;
}

/** The pieces of a dotted key or header: bare, "basic" or 'literal' segments. */
export function splitDotted(src: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  const s = src.trim();
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (s[i] === '"') {
      let j = i + 1, seg = '';
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '\\' && j + 1 < s.length) { seg += s[j + 1]; j++; } else seg += s[j];
      }
      if (j >= s.length) return null;
      out.push(seg);
      i = j + 1;
    } else if (s[i] === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return null;
      out.push(s.slice(i + 1, j));
      i = j + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) return null;
      out.push(m[0]);
      i += m[0].length;
    }
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (i < s.length) {
      if (s[i] !== '.') return null;
      i++;
    }
  }
  return out.length ? out : null;
}

/**
 * Walks the file once and marks, for every line, whether it is a top-level
 * table header and which key (if any) starts on it. Strings, comments,
 * multi-line strings and arrays/inline tables spanning lines are followed so a
 * `[` inside one is never taken for a header.
 */
export function scanToml(text: string): Line[] {
  const raw = text.split(/\r?\n/);
  const lines: Line[] = raw.map(t => ({ text: t, header: null, arrayTable: false, key: null, valueEnd: -1 }));
  let multi: '"""' | "'''" | null = null;
  let depth = 0;
  let valueStart = -1;
  for (let li = 0; li < raw.length; li++) {
    const t = raw[li];
    let i = 0;
    if (!multi && depth === 0) {
      const trimmed = t.trim();
      if (trimmed.startsWith('[')) {
        const arr = trimmed.startsWith('[[');
        const close = arr ? trimmed.indexOf(']]') : findClose(trimmed);
        if (close > 0) {
          const inner = trimmed.slice(arr ? 2 : 1, close);
          const parts = splitDotted(inner);
          if (parts) { lines[li].header = parts; lines[li].arrayTable = arr; }
        }
        continue;
      }
      const km = /^\s*((?:[A-Za-z0-9_-]+|"(?:\\.|[^"\\])*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"(?:\\.|[^"\\])*"|'[^']*'))*)\s*=/.exec(t);
      if (km) {
        lines[li].key = km[1];
        valueStart = li;
        i = km[0].length;
      } else {
        continue;   // blank, comment, or something this scanner does not need
      }
    }
    // Inside a value: follow strings, comments and brackets to the end of the line.
    while (i < t.length) {
      if (multi) {
        const end = t.indexOf(multi, i);
        if (end < 0) { i = t.length; break; }
        i = end + 3;
        while (t[i] === multi[0]) i++;   // """" closes with a quote inside
        multi = null;
        continue;
      }
      const c = t[i];
      if (c === '#') break;
      if (t.startsWith('"""', i)) { multi = '"""'; i += 3; continue; }
      if (t.startsWith("'''", i)) { multi = "'''"; i += 3; continue; }
      if (c === '"') {
        i++;
        while (i < t.length && t[i] !== '"') i += t[i] === '\\' ? 2 : 1;
        i++;
        continue;
      }
      if (c === "'") {
        const end = t.indexOf("'", i + 1);
        i = end < 0 ? t.length : end + 1;
        continue;
      }
      if (c === '[' || c === '{') depth++;
      else if ((c === ']' || c === '}') && depth > 0) depth--;
      i++;
    }
    if (!multi && depth === 0 && valueStart >= 0) {
      lines[valueStart].valueEnd = li;
      valueStart = -1;
    }
  }
  if (valueStart >= 0) lines[valueStart].valueEnd = raw.length - 1;
  return lines;
}

function findClose(header: string): number {
  let q: string | null = null;
  for (let i = 1; i < header.length; i++) {
    const c = header[i];
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"') i++; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === ']') return i;
  }
  return -1;
}

export interface TableRange {
  /** Header line index. */
  start: number;
  /** One past the last line that belongs to the table (its keys and the comments/blank lines among them). */
  end: number;
}

export interface CrbroTable {
  table: TableRange | null;
  /** [mcp_servers.crbro.*] subtables (env, tools…), in order. */
  subtables: TableRange[];
  /** key → line index, for keys of the main table. */
  keys: Map<string, number>;
  /** A registration this editor cannot change safely (inline table, dotted keys). */
  uncertain: string | null;
}

function sameName(a: string, b: string): boolean { return a === b; }

export function findCrbroTable(text: string, name: string = SERVER_NAME): CrbroTable {
  const lines = scanToml(text);
  const out: CrbroTable = { table: null, subtables: [], keys: new Map(), uncertain: null };
  const headers = lines.map((l, i) => ({ i, h: l.header })).filter(x => x.h);
  const endOf = (start: number) => {
    const next = headers.find(x => x.i > start);
    let end = next ? next.i : lines.length;
    // Comments and blank lines right before the next header belong to it, not to us.
    while (end - 1 > start && /^\s*(#.*)?$/.test(lines[end - 1].text)) end--;
    return end;
  };
  let current: 'main' | 'sub' | 'servers' | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.header) {
      const h = l.header;
      current = null;
      if (h.length >= 2 && h[0] === 'mcp_servers' && sameName(h[1], name)) {
        if (l.arrayTable) { out.uncertain = `[[${h.join('.')}]] is an array of tables`; continue; }
        if (h.length === 2) {
          if (out.table) { out.uncertain = `[mcp_servers.${name}] appears twice`; continue; }
          out.table = { start: i, end: endOf(i) };
          current = 'main';
        } else {
          out.subtables.push({ start: i, end: endOf(i) });
          current = 'sub';
        }
      } else if (h.length === 1 && h[0] === 'mcp_servers') {
        current = 'servers';
      }
      continue;
    }
    if (!l.key) continue;
    const key = splitDotted(l.key);
    if (!key) continue;
    if (current === 'main') {
      out.keys.set(key.join('.'), i);
    } else if (current === 'servers' && key[0] === name) {
      out.uncertain = `mcp_servers has ${name} as an inline key`;
    } else if (current === null && !headers.some(x => x.i < i) && key[0] === 'mcp_servers' && key[1] === name) {
      out.uncertain = `mcp_servers.${name} is set with dotted keys`;
    } else if (current === null && !headers.some(x => x.i < i) && key[0] === 'mcp_servers' && key.length === 1) {
      out.uncertain = 'mcp_servers is an inline table';
    }
  }
  return out;
}

/** A TOML basic string: JSON's escapes are a subset TOML reads the same. */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

/** The value of a single-line `key = value` as written, or null. */
function rawValue(line: string): string | null {
  const m = /^[^=]*=\s*(.*)$/.exec(line);
  if (!m) return null;
  return stripComment(m[1]).trim();
}

function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"') i++; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '#') return s.slice(0, i);
  }
  return s;
}

/** A TOML string or array of strings read loosely, for display and for "does it point at CRBRO". */
function looseStrings(value: string): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'/g)) {
    if (m[1] !== undefined) { try { out.push(JSON.parse(`"${m[1]}"`)); } catch { out.push(m[1]); } }
    else out.push(m[2]);
  }
  return out;
}

export interface CodexServerInfo {
  present: boolean;
  uncertain: string | null;
  command: string | null;
  args: string[];
  startupTimeout: number | null;
  toolTimeout: number | null;
  enabled: boolean | null;
}

/** What config.toml says about CRBRO's server, read only. */
export function readCodexServer(text: string, name: string = SERVER_NAME): CodexServerInfo {
  const t = findCrbroTable(text, name);
  const lines = text.split(/\r?\n/);
  const info: CodexServerInfo = { present: !!t.table || !!t.uncertain, uncertain: t.uncertain, command: null, args: [],
    startupTimeout: null, toolTimeout: null, enabled: null };
  const valueOf = (key: string) => {
    const at = t.keys.get(key);
    if (at === undefined) return null;
    const scanned = scanToml(text)[at];
    const end = scanned.valueEnd >= at ? scanned.valueEnd : at;
    return rawValue(lines.slice(at, end + 1).join('\n'));
  };
  const cmd = valueOf('command');
  if (cmd !== null) info.command = looseStrings(cmd)[0] ?? null;
  const args = valueOf('args');
  if (args !== null) info.args = looseStrings(args);
  const num = (v: string | null) => (v !== null && /^[+]?\d+(\.\d+)?$/.test(v) ? Number(v) : null);
  info.startupTimeout = num(valueOf(STARTUP_TIMEOUT_KEY));
  info.toolTimeout = num(valueOf(TOOL_TIMEOUT_KEY));
  const enabled = valueOf('enabled');
  info.enabled = enabled === 'true' ? true : enabled === 'false' ? false : null;
  return info;
}

/** True when a command line runs CRBRO: the npm package, or a stable engine folder. */
export function pointsAtCrbro(command: string | null, args: string[]): boolean {
  const all = [command ?? '', ...args].join(' ').replace(/\\/g, '/').toLowerCase();
  return /crbro-memory|\.crbro-engine|crbro\.mjs/.test(all);
}

export interface EnsureOptions {
  command: string;
  args: string[];
  /** Replace an existing command/args with these (the stable engine). Default: keep what is there. */
  replaceCommand?: boolean;
  startupTimeout?: number;
  toolTimeout?: number;
}

export interface EnsureResult {
  text: string;
  changed: boolean;
  /** One line each, for the CLI. */
  actions: string[];
  /** Values the user had and CRBRO left as they were. */
  kept: string[];
  /** Nothing was changed because the registration could not be edited safely. */
  refused: string | null;
}

function eolOf(text: string): string { return /\r\n/.test(text) ? '\r\n' : '\n'; }

/**
 * Makes sure [mcp_servers.crbro] exists and carries both timeouts. Adds only
 * what is missing; a value the user set is kept and reported.
 */
export function ensureCodexServer(text: string, opts: EnsureOptions): EnsureResult {
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  const eol = eolOf(body);
  const startup = opts.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT;
  const tool = opts.toolTimeout ?? DEFAULT_TOOL_TIMEOUT;
  const found = findCrbroTable(body);
  const result: EnsureResult = { text, changed: false, actions: [], kept: [], refused: null };
  if (found.uncertain) {
    result.refused = `${found.uncertain}; add ${STARTUP_TIMEOUT_KEY} = ${startup} and ${TOOL_TIMEOUT_KEY} = ${tool} to it by hand.`;
    return result;
  }
  const lines = body.split(/\r?\n/);
  if (!found.table) {
    const block = [
      `[mcp_servers.${SERVER_NAME}]`,
      `command = ${tomlString(opts.command)}`,
      `args = ${tomlArray(opts.args)}`,
      `${STARTUP_TIMEOUT_KEY} = ${startup}`,
      `${TOOL_TIMEOUT_KEY} = ${tool}`,
    ];
    // Appended at the end, after one blank line; the file keeps its last newline.
    const hadFinalNewline = body.length === 0 || /\r?\n$/.test(body);
    const trimmed = [...lines];
    if (hadFinalNewline && trimmed.length && trimmed[trimmed.length - 1] === '') trimmed.pop();
    while (trimmed.length && trimmed[trimmed.length - 1].trim() === '') trimmed.pop();
    const out = trimmed.length ? [...trimmed, '', ...block] : block;
    result.text = (bom ? '\ufeff' : '') + out.join(eol) + eol;
    result.changed = true;
    result.actions.push(`registered the MCP server [mcp_servers.${SERVER_NAME}] (${[opts.command, ...opts.args].join(' ')})`);
    result.actions.push(`${STARTUP_TIMEOUT_KEY} = ${startup}, ${TOOL_TIMEOUT_KEY} = ${tool}`);
    return result;
  }

  const info = readCodexServer(body);
  const scanned = scanToml(body);
  const edits: Array<{ at: number; remove: number; insert: string[] }> = [];
  // Insertion point: right after the last key line (and its multi-line value) of the main table.
  let insertAt = found.table.start + 1;
  for (const at of found.keys.values()) {
    const end = scanned[at].valueEnd >= at ? scanned[at].valueEnd : at;
    insertAt = Math.max(insertAt, end + 1);
  }
  const additions: string[] = [];

  if (opts.replaceCommand) {
    const want = { command: opts.command, args: opts.args };
    const same = info.command === want.command && JSON.stringify(info.args) === JSON.stringify(want.args);
    if (!same) {
      for (const key of ['command', 'args'] as const) {
        const at = found.keys.get(key);
        const line = key === 'command' ? `command = ${tomlString(want.command)}` : `args = ${tomlArray(want.args)}`;
        if (at === undefined) { additions.push(line); continue; }
        const end = scanned[at].valueEnd >= at ? scanned[at].valueEnd : at;
        edits.push({ at, remove: end - at + 1, insert: [line] });
      }
      result.actions.push(`[mcp_servers.${SERVER_NAME}] now runs ${[opts.command, ...opts.args].join(' ')} (was: ${[info.command ?? '?', ...info.args].join(' ')})`);
    }
  } else if (!found.keys.has('command') && !found.keys.has('url')) {
    additions.push(`command = ${tomlString(opts.command)}`, `args = ${tomlArray(opts.args)}`);
    result.actions.push(`[mcp_servers.${SERVER_NAME}] had no command: added ${[opts.command, ...opts.args].join(' ')}`);
  }

  if (found.keys.has(STARTUP_TIMEOUT_KEY)) result.kept.push(`${STARTUP_TIMEOUT_KEY} = ${info.startupTimeout ?? rawValue(lines[found.keys.get(STARTUP_TIMEOUT_KEY)!])}`);
  else { additions.push(`${STARTUP_TIMEOUT_KEY} = ${startup}`); result.actions.push(`added ${STARTUP_TIMEOUT_KEY} = ${startup}`); }
  if (found.keys.has(TOOL_TIMEOUT_KEY)) result.kept.push(`${TOOL_TIMEOUT_KEY} = ${info.toolTimeout ?? rawValue(lines[found.keys.get(TOOL_TIMEOUT_KEY)!])}`);
  else { additions.push(`${TOOL_TIMEOUT_KEY} = ${tool}`); result.actions.push(`added ${TOOL_TIMEOUT_KEY} = ${tool}`); }

  if (additions.length) edits.push({ at: insertAt, remove: 0, insert: additions });
  if (!edits.length) return result;
  // Applied bottom-up so earlier indexes stay valid.
  edits.sort((a, b) => b.at - a.at || a.remove - b.remove);
  for (const e of edits) lines.splice(e.at, e.remove, ...e.insert);
  result.text = (bom ? '\ufeff' : '') + lines.join(eol);
  result.changed = true;
  return result;
}

export interface RemoveResult {
  text: string;
  changed: boolean;
  /** What was there, when it was not CRBRO's (left alone). */
  notOurs: string | null;
  refused: string | null;
}

/**
 * Takes [mcp_servers.crbro] and its subtables out, only when it runs CRBRO.
 * The blank line that separated it from the table before goes with it.
 */
export function removeCodexServer(text: string): RemoveResult {
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  const eol = eolOf(body);
  const found = findCrbroTable(body);
  const result: RemoveResult = { text, changed: false, notOurs: null, refused: null };
  if (found.uncertain) { result.refused = `${found.uncertain}: remove it by hand`; return result; }
  if (!found.table && found.subtables.length === 0) return result;
  const info = readCodexServer(body);
  if (found.table && !pointsAtCrbro(info.command, info.args)) {
    result.notOurs = [info.command ?? '(no command)', ...info.args].join(' ');
    return result;
  }
  const lines = body.split(/\r?\n/);
  const ranges = [...(found.table ? [found.table] : []), ...found.subtables].sort((a, b) => b.start - a.start);
  for (const r of ranges) {
    let start = r.start;
    let end = r.end;
    // Blank lines after the table's last key, up to the next header, go too.
    while (end < lines.length && lines[end].trim() === '') end++;
    if (end >= lines.length) {
      // Last table in the file: drop the blank line(s) before it instead.
      while (start > 0 && lines[start - 1].trim() === '') start--;
    }
    lines.splice(start, end - start);
  }
  let out = lines.join(eol);
  if (/\r?\n$/.test(body) && !out.endsWith(eol)) out += eol;
  result.text = (bom ? '\ufeff' : '') + out;
  result.changed = true;
  return result;
}
