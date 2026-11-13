// ─── Markdown in and out ─────────────────────────────────────────
//
// The little Markdown this package needs: YAML-ish frontmatter (the subset
// Claude Code memory files and Obsidian notes use), splitting a CLAUDE.md
// into topics and entries, and the entry markers of an exported vault.

// ─── Frontmatter ─────────────────────────────────────────────────

export interface Frontmatter {
  data: Record<string, any>;
  body: string;
  /** The file opened with a `---` block. */
  present: boolean;
}

function scalar(raw: string): any {
  const v = raw.trim();
  if (v === '') return '';
  if (v.startsWith('"')) {
    try { return JSON.parse(v); } catch { return v.slice(1, v.endsWith('"') ? -1 : undefined); }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  if (v.startsWith('[') && v.endsWith(']')) {
    try { return JSON.parse(v); } catch {
      return v.slice(1, -1).split(',').map(s => scalar(s)).filter(s => s !== '');
    }
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/**
 * Parse a leading `---` block. Handles `key: value`, one level of nested
 * maps (`metadata:` then indented keys), block lists (`- item`), flow lists
 * and quoted strings. Anything it does not understand is kept as a string.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const src = text.replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { data: {}, body: src, present: false };
  const data: Record<string, any> = {};
  let parent: Record<string, any> | null = null;
  let listKey: { obj: Record<string, any>; key: string } | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const t = line.trim();
    if (t.startsWith('- ') && listKey) {
      const arr = Array.isArray(listKey.obj[listKey.key]) ? listKey.obj[listKey.key] : [];
      arr.push(scalar(t.slice(2)));
      listKey.obj[listKey.key] = arr;
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*:(.*)$/.exec(t);
    if (!kv) continue;
    const [, key, rest] = kv;
    const target: Record<string, any> = indent > 0 && parent ? parent : data;
    if (indent === 0) parent = null;
    if (rest.trim() === '') {
      // A nested map or a block list follows.
      target[key] = {};
      if (indent === 0) parent = target[key];
      listKey = { obj: target, key };
      continue;
    }
    target[key] = scalar(rest);
    listKey = null;
  }
  // `key:` followed by nothing at all is an empty string, not an empty map.
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) data[k] = '';
  }
  return { data, body: src.slice(m[0].length), present: true };
}

/** A frontmatter value written so parseFrontmatter (and Obsidian) read it back exactly. */
export function yamlValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(x => JSON.stringify(String(x))).join(', ')}]`;
  return JSON.stringify(String(v));
}

export function frontmatterBlock(fields: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    lines.push(`${k}: ${yamlValue(v)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

// ─── CLAUDE.md / AGENTS.md → topics and entries ──────────────────

export interface MdSection {
  /** Topic name for this section. */
  topic: string;
  /** One entry per bullet, paragraph, table or code block. */
  entries: string[];
}

const stripInline = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '').trim();

/** Heading text without trailing #'s and without wrapping emphasis. */
function headingText(raw: string): string {
  return raw.replace(/\s+#+\s*$/, '').replace(/^[*_`]+|[*_`]+$/g, '').trim();
}

/**
 * Split an instructions file into topics. Headings become topics: the single
 * H1 at the top (or `rootName` when there is none, or several) names the
 * document, each H2 under it becomes "<root> — <H2>", and deeper headings
 * stay inside their H2 so a "### Examples" never becomes a neuron of its own.
 * Bullets (with their continuation lines and sub-items), paragraphs, tables,
 * quotes and fenced code blocks each become one entry. Horizontal rules,
 * HTML comments and empty sections are dropped.
 */
export function splitInstructions(markdown: string, rootName: string): MdSection[] {
  const text = markdown.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const lines = text.split('\n');

  // Pass 1: is there exactly one H1? Then it names the document.
  const h1s = lines.filter((l, i) => /^#\s+\S/.test(l) && !insideFence(lines, i));
  const root = h1s.length === 1 ? headingText(h1s[0].replace(/^#\s+/, '')) || rootName : rootName;
  const topLevel = h1s.length === 1 ? 2 : 1;

  const sections: MdSection[] = [];
  let current: MdSection = { topic: root, entries: [] };
  sections.push(current);
  let block: string[] = [];
  let blockKind: 'none' | 'para' | 'list' | 'fence' | 'table' | 'quote' = 'none';
  let fenceMarker = '';
  // The text of the H3+ heading the next entries sit under, so each one stays self-contained.
  let lead = '';

  const flush = () => {
    const t = block.join('\n').replace(/\s+$/, '');
    const clean = blockKind === 'fence' ? t : stripInline(t);
    if (clean && clean.replace(/[\s*_`>#|:-]/g, '').length >= 2) {
      current.entries.push(lead ? `${lead}:${blockKind === 'fence' ? '\n' : ' '}${clean}` : clean);
    }
    block = [];
    blockKind = 'none';
  };

  for (const line of lines) {
    if (blockKind === 'fence') {
      block.push(line);
      if (line.trim().startsWith(fenceMarker)) { flush(); }
      continue;
    }
    const fence = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      flush();
      blockKind = 'fence';
      fenceMarker = fence[1];
      block.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      const name = headingText(heading[2]);
      if (level === 1 && topLevel === 2) continue;          // the document title
      if (level === topLevel && name) {
        current = { topic: `${root} — ${name}`, entries: [] };
        sections.push(current);
        lead = '';
      } else if (level > topLevel && name) {
        // A sub-heading stays in its section, as the lead of what follows.
        lead = name;
      }
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); continue; }   // horizontal rule
    if (!line.trim()) {
      if (blockKind === 'list') { block.push(''); continue; }             // a list item may span a blank line
      flush();
      continue;
    }
    const bullet = /^([-*+]|\d+[.)])\s+/.exec(line);
    if (bullet) {
      // A new top-level item closes the previous one.
      if (blockKind !== 'list' || block.length) flush();
      blockKind = 'list';
      block.push(line.replace(/^([-*+]|\d+[.)])\s+/, ''));
      continue;
    }
    if (blockKind === 'list') {
      // Indented lines continue the item; an unindented line after a blank ends the list.
      const prevBlank = block[block.length - 1] === '';
      if (/^\s+/.test(line) || !prevBlank) { block.push(line); continue; }
      flush();
    }
    const isTable = /^\s*\|/.test(line);
    const isQuote = /^\s*>/.test(line);
    const kind = isTable ? 'table' : isQuote ? 'quote' : 'para';
    if (blockKind !== kind) flush();
    blockKind = kind;
    block.push(line);
  }
  flush();
  return sections.filter(s => s.entries.length > 0).map(s => ({ ...s, entries: s.entries.map(e => e.replace(/\n{3,}/g, '\n\n').trim()) }));
}

function insideFence(lines: string[], index: number): boolean {
  let open = false;
  for (let i = 0; i < index; i++) if (/^\s*(```|~~~)/.test(lines[i])) open = !open;
  return open;
}

// ─── Exported vault notes ────────────────────────────────────────

export interface VaultEntry {
  kind: string;
  id: string;
  status: string;
  text: string;
  keywords?: string[];
  rationale?: string;
}

const ENTRY_OPEN = /^<!-- crbro:entry (.*?) -->$/;
const ENTRY_CLOSE = '<!-- /crbro:entry -->';
const WHY = '<!-- crbro:why -->';

/** Comments cannot hold "--": every dash inside the JSON is written as -. */
export function entryMarker(fields: Record<string, unknown>): string {
  const attrs = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${JSON.stringify(v).replace(/-/g, '\\u002d')}`)
    .join(' ');
  return `<!-- crbro:entry ${attrs} -->`;
}

export const ENTRY_END = ENTRY_CLOSE;
export const ENTRY_WHY = WHY;

/** Neutralise a marker that happens to appear inside an entry's own text. */
export function defuseMarkers(text: string): string {
  return text.replace(/<!--(\s*\/?crbro:)/g, '&lt;!--$1');
}

function parseAttrs(s: string): Record<string, any> {
  const out: Record<string, any> = {};
  const re = /([a-z_]+)=("(?:[^"\\]|\\.)*"|\[[^\]]*\]|\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    try { out[m[1]] = JSON.parse(m[2]); } catch { out[m[1]] = m[2]; }
  }
  return out;
}

/**
 * The entries of one exported neuron note. Each block is: the open marker,
 * one meta line (written for people, skipped here), the text, optionally the
 * rationale after a why marker, the close marker.
 */
export function parseVaultEntries(body: string): VaultEntry[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const out: VaultEntry[] = [];
  let cur: { attrs: Record<string, any>; text: string[]; why: string[] | null; metaSkipped: boolean } | null = null;
  for (const line of lines) {
    if (!cur) {
      const open = ENTRY_OPEN.exec(line.trim());
      if (open) cur = { attrs: parseAttrs(open[1]), text: [], why: null, metaSkipped: false };
      continue;
    }
    if (line.trim() === ENTRY_CLOSE) {
      const text = cur.text.join('\n').trim();
      if (text) {
        out.push({
          kind: String(cur.attrs.kind ?? 'fact'),
          id: String(cur.attrs.id ?? ''),
          status: String(cur.attrs.status ?? 'active'),
          text,
          ...(Array.isArray(cur.attrs.keywords) ? { keywords: cur.attrs.keywords.map(String) } : {}),
          ...(cur.why && cur.why.join('\n').trim() ? { rationale: cur.why.join('\n').trim().replace(/^\*\*Why:\*\*\s*/, '') } : {}),
        });
      }
      cur = null;
      continue;
    }
    if (!cur.metaSkipped) {
      if (!line.trim()) continue;
      cur.metaSkipped = true;   // the human-readable meta line
      continue;
    }
    if (line.trim() === WHY) { cur.why = []; continue; }
    (cur.why ?? cur.text).push(line);
  }
  return out;
}
