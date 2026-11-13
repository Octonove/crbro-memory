// ─── export / import / view / serve: the pure helpers ────────────
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  parseFrontmatter, splitInstructions, parseVaultEntries, entryMarker, ENTRY_END, ENTRY_WHY, frontmatterBlock,
} from '../src/cli/markdown.js';
import {
  parseArgs, safeFileName, isInside, tokenMatches, bearerOf, hostAllowed, loopbackHosts, isLoopbackHost, randomToken,
} from '../src/cli/common.js';
import { memoryKind, memoryProjectName, documentRootName, storedId, learnTopicOf, protocolLost } from '../src/cli/import.js';
import { allowedHostHeaders } from '../src/cli/serve.js';
import { factId } from '../src/utils/hash.js';
import { entryId } from '../src/sync/ops.js';

describe('frontmatter', () => {
  it('reads a Claude Code memory file: nested metadata, quotes, lists', () => {
    const fm = parseFrontmatter('---\nname: No reformatear\ndescription: "Solo tocar lo pedido: nada más"\nmetadata:\n  type: feedback\n  tags: [a, b]\naliases:\n  - uno\n  - "dos"\n---\nCuerpo\n');
    expect(fm.present).toBe(true);
    expect(fm.data.name).toBe('No reformatear');
    expect(fm.data.description).toBe('Solo tocar lo pedido: nada más');
    expect(fm.data.metadata).toEqual({ type: 'feedback', tags: ['a', 'b'] });
    expect(fm.data.aliases).toEqual(['uno', 'dos']);
    expect(fm.body).toBe('Cuerpo\n');
  });

  it('round-trips what the exporter writes, with CRLF and a BOM', () => {
    const block = frontmatterBlock({ id: 'project_x', name: 'Ünïcode "quoted" — name', tags: ['a', 'b:c'], heat: 0.5, archived: true });
    const fm = parseFrontmatter('﻿' + block.replace(/\n/g, '\r\n') + '\r\nbody');
    expect(fm.data).toEqual({ id: 'project_x', name: 'Ünïcode "quoted" — name', tags: ['a', 'b:c'], heat: 0.5, archived: true });
    expect(fm.body).toBe('body');
  });

  it('a file without frontmatter is all body', () => {
    expect(parseFrontmatter('# Title\ntext')).toEqual({ data: {}, body: '# Title\ntext', present: false });
  });
});

describe('CLAUDE.md → topics and entries', () => {
  const doc = [
    '# Acme web', '', 'Acme is the storefront.', '',
    '## Commands', '', '- Build with `npm run build`.', '- Test with vitest', '  before every commit.', '',
    '1. Numbered item', '',
    '## Style', '', 'Two spaces.', 'Same paragraph.', '', '### Naming', '', '- PascalCase components.', '',
    '```bash', '# not a heading', 'npm run deploy', '```', '', '---', '',
    '| a | b |', '|---|---|', '| 1 | 2 |', '', '<!-- hidden note -->', '> a quote',
  ].join('\n');

  it('one H1 names the document, each H2 is a topic, H3 leads its entries', () => {
    const s = splitInstructions(doc, 'fallback');
    expect(s.map(x => x.topic)).toEqual(['Acme web', 'Acme web — Commands', 'Acme web — Style']);
    expect(s[0].entries).toEqual(['Acme is the storefront.']);
    expect(s[1].entries).toEqual(['Build with `npm run build`.', 'Test with vitest\n  before every commit.', 'Numbered item']);
    expect(s[2].entries[0]).toBe('Two spaces.\nSame paragraph.');
    expect(s[2].entries[1]).toBe('Naming: PascalCase components.');
    expect(s[2].entries[2]).toBe('Naming:\n```bash\n# not a heading\nnpm run deploy\n```');
    expect(s[2].entries).toContain('Naming: | a | b |\n|---|---|\n| 1 | 2 |');
    expect(s[2].entries).toContain('Naming: > a quote');
    expect(s.flatMap(x => x.entries).join(' ')).not.toContain('hidden note');
  });

  it('without a single H1 the file name roots the topics', () => {
    const s = splitInstructions('intro\n\n# One\n\n- a fact\n\n# Two\n\n- b fact\n', 'proj');
    expect(s.map(x => x.topic)).toEqual(['proj', 'proj — One', 'proj — Two']);
  });

  it('the root of a CLAUDE.md is its folder', () => {
    expect(documentRootName(path.join('x', 'acme', 'CLAUDE.md'))).toBe('acme');
    expect(documentRootName(path.join('x', 'acme', 'AGENTS.md'))).toBe('acme');
    expect(documentRootName(path.join('x', 'notes.md'))).toBe('notes');
  });
});

describe('Claude Code memory mapping', () => {
  it('user → preference, feedback → pattern, project/reference/unknown → fact', () => {
    expect(memoryKind('user')).toBe('preference');
    expect(memoryKind('feedback')).toBe('pattern');
    expect(memoryKind('project')).toBe('fact');
    expect(memoryKind('reference')).toBe('fact');
    expect(memoryKind(undefined)).toBe('fact');
  });

  it('names the topic after the project the memory folder belongs to', () => {
    expect(memoryProjectName(path.join('h', '.claude', 'projects', 'C--Users-me-Desktop-Workflows', 'memory'))).toBe('Workflows');
    expect(memoryProjectName(path.join('somewhere', 'notes'))).toBe('notes');
  });
});

describe('vault entries', () => {
  it('parse back exactly what the exporter writes, rationale and keywords included', () => {
    const body = [
      '# X', '',
      entryMarker({ kind: 'decision', id: 'abc', status: 'active' }),
      '`decision` · id `abc` · 2026-01-01 · active · unverified', '',
      'Use Postgres -- not Mongo.', '', ENTRY_WHY, '**Why:** joins.', ENTRY_END, '',
      entryMarker({ kind: 'fact', id: 'def', status: 'superseded', keywords: ['db--old', 'pg'] }),
      'meta', '', 'Old line', ENTRY_END,
    ].join('\n');
    expect(entryMarker({ keywords: ['a--b'] }).slice(4, -3)).not.toContain('--');
    const e = parseVaultEntries(body);
    expect(e).toEqual([
      { kind: 'decision', id: 'abc', status: 'active', text: 'Use Postgres -- not Mongo.', rationale: 'joins.' },
      { kind: 'fact', id: 'def', status: 'superseded', text: 'Old line', keywords: ['db--old', 'pg'] },
    ]);
  });
});

describe('ids an import compares', () => {
  it('trims and redacts like learn before hashing', () => {
    expect(storedId({ kind: 'fact', text: '  Port 8080  ' })).toBe(factId('Port 8080'));
    expect(storedId({ kind: 'pattern', text: 'a  b' })).toBe(entryId('a b'));
    const withKey = storedId({ kind: 'fact', text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB' });
    expect(withKey).toBe(factId('token [REDACTED: GitHub token]'));
    expect(storedId({ kind: 'map', text: 'anything' })).toBe('map');
  });

  it('steers a protocol name only when the inference can be steered', () => {
    expect(learnTopicOf({ topic: 'Writing style', type: 'protocol', entries: [], source: '' })).toBe('Writing style protocol');
    expect(learnTopicOf({ topic: 'Zero rules', type: 'protocol', entries: [], source: '' })).toBe('Zero rules');
    expect(protocolLost({ topic: 'Deploy discipline', type: 'protocol', entries: [], source: '' })).toBe(true);
    expect(learnTopicOf({ topic: 'Acme', type: 'project', entries: [], source: '' })).toBe('Acme');
  });
});

describe('arguments, paths and guards', () => {
  it('parses flags strictly', () => {
    const a = parseArgs(['x', '--out', 'd', '--format=json', '--include-retired', '--port', '12', '--h', 'a', '--h', 'b'],
      { out: 'string', format: 'string', 'include-retired': 'boolean', port: 'number', h: 'list' });
    expect(a).toEqual({ flags: { out: 'd', format: 'json', 'include-retired': true, port: 12, h: ['a', 'b'] }, positionals: ['x'], errors: [] });
    expect(parseArgs(['--nope'], {}).errors).toEqual(['unknown option --nope']);
    expect(parseArgs(['--port', 'x1'], { port: 'number' }).errors).toEqual(['--port must be a whole number']);
    expect(parseArgs(['--out'], { out: 'string' }).errors).toEqual(['--out needs a value']);
    expect(parseArgs(['--help'], {}).flags.help).toBe(true);
  });

  it('file names never escape their folder', () => {
    for (const bad of ['..', '../../etc/passwd', '..\\..\\x', 'a/b', 'CON', 'nul.txt', '', '   ', '.hidden']) {
      const n = safeFileName(bad);
      expect(n).not.toMatch(/[\\/]/);
      expect(n).not.toBe('..');
      expect(n).not.toBe('.');
      expect(n.length).toBeGreaterThan(0);
      expect(/^(con|nul)(\..*)?$/i.test(n)).toBe(false);
    }
    expect(safeFileName('project_acme')).toBe('project_acme');
    expect(safeFileName('Búsqueda web')).toBe('Busqueda_web');
  });

  it('containment', () => {
    const root = path.resolve('brain');
    expect(isInside(path.join(root, 'x'), root)).toBe(true);
    expect(isInside(root, root)).toBe(true);
    expect(isInside(path.resolve('brain-other'), root)).toBe(false);
    expect(isInside(path.join(root, '..', 'x'), root)).toBe(false);
  });

  it('tokens: constant-time match, bearer parsing, hosts', () => {
    const t = randomToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenMatches(t, t)).toBe(true);
    expect(tokenMatches(t.slice(0, -1), t)).toBe(false);
    expect(tokenMatches('', t)).toBe(false);
    expect(tokenMatches(undefined, t)).toBe(false);
    expect(bearerOf(`Bearer ${t}`)).toBe(t);
    expect(bearerOf(`bearer ${t}`)).toBe(t);
    expect(bearerOf(`Basic ${t}`)).toBeNull();
    expect(bearerOf(undefined)).toBeNull();
    expect(hostAllowed('127.0.0.1:5000', loopbackHosts(5000))).toBe(true);
    expect(hostAllowed('LOCALHOST:5000', loopbackHosts(5000))).toBe(true);
    expect(hostAllowed('evil.example:5000', loopbackHosts(5000))).toBe(false);
    expect(hostAllowed('127.0.0.1:5001', loopbackHosts(5000))).toBe(false);
    expect(hostAllowed(undefined, loopbackHosts(5000))).toBe(false);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.2')).toBe(false);
    expect(allowedHostHeaders('0.0.0.0', 8787, ['mem.example.org'])).toEqual(['0.0.0.0:8787', 'mem.example.org']);
    expect(allowedHostHeaders('127.0.0.1', 8787)).toContain('localhost:8787');
  });
});
