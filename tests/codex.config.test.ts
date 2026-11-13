import { describe, it, expect } from 'vitest';
import { ensureCodexServer, findCrbroTable, readCodexServer, removeCodexServer, scanToml } from '../src/engine/codexconfig.js';

/**
 * config.toml is the user's file, edited a line at a time: what CRBRO adds is
 * whole lines inside its own table, what it removes is its own table, and
 * every other byte — comments, other tables, quoting, CRLF — stays put.
 */
const SPEC = { command: 'npx', args: ['-y', 'crbro-memory'] };
const added = (before: string, after: string) => {
  const a = before.split(/\r?\n/), b = after.split(/\r?\n/);
  return b.filter(l => !a.includes(l));
};

describe('config.toml: registration and timeouts', () => {
  it('appends the table to an empty or a missing file', () => {
    const r = ensureCodexServer('', SPEC);
    expect(r.changed).toBe(true);
    expect(r.text).toBe('[mcp_servers.crbro]\ncommand = "npx"\nargs = ["-y", "crbro-memory"]\nstartup_timeout_sec = 60\ntool_timeout_sec = 120\n');
  });

  it('appends after the last table, one blank line between, keeping CRLF and the comments', () => {
    const before = '# top comment\r\nmodel = "x"\r\n\r\n[mcp_servers.other] # trailing comment\r\ncommand = "o"\r\n';
    const r = ensureCodexServer(before, SPEC);
    expect(r.text.startsWith(before)).toBe(true);
    expect(r.text).toBe(before + '\r\n[mcp_servers.crbro]\r\ncommand = "npx"\r\nargs = ["-y", "crbro-memory"]\r\nstartup_timeout_sec = 60\r\ntool_timeout_sec = 120\r\n');
  });

  it('adds only the missing timeouts, inside the table, before its subtables', () => {
    const before = [
      '[mcp_servers.crbro]', 'command = "npx"', 'args = [', '  "-y",', '  "crbro-memory",', ']', 'tool_timeout_sec = 300', '# a note',
      '', '[mcp_servers.crbro.env]', 'NODE_OPTIONS = "--use-system-ca"', '',
    ].join('\n');
    const r = ensureCodexServer(before, SPEC);
    expect(added(before, r.text)).toEqual(['startup_timeout_sec = 60']);
    expect(r.kept).toEqual(['tool_timeout_sec = 300']);
    const lines = r.text.split('\n');
    expect(lines.indexOf('startup_timeout_sec = 60')).toBe(lines.indexOf('tool_timeout_sec = 300') + 1);
    expect(lines.indexOf('startup_timeout_sec = 60')).toBeLessThan(lines.indexOf('[mcp_servers.crbro.env]'));
  });

  it('a value the user set is never overridden, whatever its spelling', () => {
    const before = '[mcp_servers.crbro]\ncommand = "npx"\nstartup_timeout_sec = 120.0\ntool_timeout_sec = 120.0\n';
    const r = ensureCodexServer(before, SPEC);
    expect(r.changed).toBe(false);
    expect(r.text).toBe(before);
    expect(r.kept).toEqual(['startup_timeout_sec = 120', 'tool_timeout_sec = 120']);
  });

  it('recognises quoted and spaced headers', () => {
    expect(findCrbroTable('[ mcp_servers . "crbro" ]\ncommand = "x"\n').table).not.toBeNull();
    expect(findCrbroTable("['mcp_servers'.'crbro']\ncommand = \"x\"\n").table).not.toBeNull();
    expect(findCrbroTable('[mcp_servers.crbro-two]\ncommand = "x"\n').table).toBeNull();
  });

  it('a [ inside a multi-line string or array is not a header', () => {
    const text = [
      'notes = """', '[mcp_servers.crbro]', 'not a table', '"""',
      "lit = '''", '[mcp_servers.crbro]', "'''",
      'arr = [', '  ["nested"],', ']',
      '[mcp_servers.real]', 'command = "r"', '',
    ].join('\n');
    expect(findCrbroTable(text).table).toBeNull();
    expect(scanToml(text).filter(l => l.header).map(l => l.header!.join('.'))).toEqual(['mcp_servers.real']);
    const r = ensureCodexServer(text, SPEC);
    expect(r.text.startsWith(text)).toBe(true);
    // The two inside strings stay strings; exactly one real table is appended after them.
    expect(r.text.slice(text.length).match(/^\[mcp_servers\.crbro\]$/gm)).toHaveLength(1);
  });

  it('refuses what it cannot edit safely: an inline table or dotted keys', () => {
    const inline = '[mcp_servers]\ncrbro = { command = "npx" }\n';
    expect(ensureCodexServer(inline, SPEC).refused).toMatch(/inline/);
    expect(ensureCodexServer(inline, SPEC).text).toBe(inline);
    const dotted = 'mcp_servers.crbro.command = "npx"\n';
    expect(ensureCodexServer(dotted, SPEC).refused).toMatch(/dotted/);
  });

  it('points an existing registration at the stable engine when asked, multi-line args included, keeping the rest', () => {
    const before = '[mcp_servers.crbro]\r\ncommand = "npx"\r\nargs = [\r\n  "-y",\r\n  "crbro-memory",\r\n]\r\nenabled = true\r\n';
    const r = ensureCodexServer(before, { command: 'C:\\node\\node.exe', args: ['C:\\Users\\u\\.crbro-engine\\crbro.mjs'], replaceCommand: true });
    expect(r.text).toBe('[mcp_servers.crbro]\r\ncommand = "C:\\\\node\\\\node.exe"\r\nargs = ["C:\\\\Users\\\\u\\\\.crbro-engine\\\\crbro.mjs"]\r\nenabled = true\r\nstartup_timeout_sec = 60\r\ntool_timeout_sec = 120\r\n');
    const info = readCodexServer(r.text);
    expect(info.command).toBe('C:\\node\\node.exe');
    expect(info.args).toEqual(['C:\\Users\\u\\.crbro-engine\\crbro.mjs']);
    expect(info.enabled).toBe(true);
  });

  it('keeps a BOM and a file without a final newline', () => {
    const r = ensureCodexServer('\ufeff[mcp_servers.crbro]\ncommand = "npx"', SPEC);
    expect(r.text.charCodeAt(0)).toBe(0xfeff);
    expect(r.text.endsWith('tool_timeout_sec = 120')).toBe(true);
  });
});

describe('config.toml: removal', () => {
  it('takes out the table and its subtables, nothing else', () => {
    const before = [
      '# keep me', '[mcp_servers.a]', 'command = "a"', '',
      '[mcp_servers.crbro]', 'command = "npx"', 'args = ["-y", "crbro-memory"]', '',
      '[mcp_servers.crbro.env]', 'NODE_OPTIONS = "x"', '',
      '[mcp_servers.crbro.tools.crbro_boot]', 'approval_mode = "approve"', '',
      '# about b', '[mcp_servers.b]', 'command = "b"', '',
    ].join('\r\n');
    const r = removeCodexServer(before);
    expect(r.changed).toBe(true);
    expect(r.text).toBe(['# keep me', '[mcp_servers.a]', 'command = "a"', '', '# about b', '[mcp_servers.b]', 'command = "b"', ''].join('\r\n'));
  });

  it('the last table in the file goes with the blank line before it', () => {
    const r = removeCodexServer('[x]\na = 1\n\n[mcp_servers.crbro]\ncommand = "node"\nargs = ["C:/u/.crbro-engine/crbro.mjs"]\n');
    expect(r.text).toBe('[x]\na = 1\n');
  });

  it('leaves alone a crbro table that runs something else', () => {
    const before = '[mcp_servers.crbro]\ncommand = "my-own-thing"\n';
    const r = removeCodexServer(before);
    expect(r.changed).toBe(false);
    expect(r.notOurs).toBe('my-own-thing');
    expect(r.text).toBe(before);
  });
});
