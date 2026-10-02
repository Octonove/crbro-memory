import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { findSessions, readJsonl, newReadStats, encodeProjectDir, claudeProjectsRoot } from '../src/utils/transcripts.js';
import { collectUsage, pickUsage, formatUsage } from '../src/engine/usage.js';
import {
  runPostmortem, formatPostmortem, toolResults, toolCalls, userText, correctionLabel,
} from '../src/engine/postmortem.js';

/**
 * `crbro usage` and `crbro postmortem` over synthetic Claude Code transcripts,
 * laid out the way Claude Code lays them out:
 *   <projects>/<project>/<session>.jsonl
 *   <projects>/<project>/<session>/subagents/agent-*.jsonl
 *   <projects>/<project>/<session>/subagents/workflows/<wf>/agent-*.jsonl
 * What matters most is what must NOT happen: content in the usage report, a
 * tool result or an unredacted secret in the post-mortem.
 */

// Fake credentials, assembled at run time so no token-shaped literal sits in the repo.
const FAKE_GH = 'ghp_' + 'Qw34'.repeat(9);
const CONTENT_MARK = 'CONTENIDO_PRIVADO_7f3a';
const RESULT_MARK = 'RESULTADO_DE_HERRAMIENTA_9c1d';
const INPUT_MARK = 'ENTRADA_DE_HERRAMIENTA_2b8e';

const PROJECT = 'C--work-demo-app';
const S1 = '11111111-aaaa-4bbb-8ccc-000000000001';
const S2 = '22222222-aaaa-4bbb-8ccc-000000000002';
const S3 = '33333333-aaaa-4bbb-8ccc-000000000003';

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'crbro-transcripts-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function write(rel: string, lines: Array<unknown | string>, opts: { tornTail?: string } = {}): string {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  const body = lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n' + (opts.tornTail ?? '');
  writeFileSync(p, body);
  return p;
}

const assistant = (id: string, model: string, usage: Record<string, number>, content: unknown[], extra: Record<string, unknown> = {}) =>
  ({ type: 'assistant', requestId: 'req_' + id, timestamp: '2026-10-01T10:00:00.000Z', uuid: 'u-' + id + Math.random(), message: { id, model, role: 'assistant', content, usage }, ...extra });
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: 'user', timestamp: '2026-10-01T10:00:00.000Z', uuid: 'u-' + Math.random(), message: { role: 'user', content }, ...extra });
const toolUse = (id: string, name: string) => ({ type: 'tool_use', id, name, input: { command: INPUT_MARK } });
const toolResult = (id: string, isError: boolean) =>
  user([{ type: 'tool_result', tool_use_id: id, is_error: isError, content: `${RESULT_MARK} ${FAKE_GH}` }]);

// ─── The reader ───────────────────────────────────────────────────

describe('transcript reader', () => {
  it('finds main logs and both kinds of subagent logs, and skips folders that are not sessions', async () => {
    write(`${PROJECT}/${S1}.jsonl`, [user('hola')]);
    write(`${PROJECT}/${S1}/subagents/agent-a1.jsonl`, [user('x')]);
    write(`${PROJECT}/${S1}/subagents/workflows/wf_1/agent-b2.jsonl`, [user('x')]);
    mkdirSync(join(root, PROJECT, 'memory'), { recursive: true });   // not a session
    write(`other-project/${S2}.jsonl`, [user('hola')]);

    const all = await findSessions({ root });
    expect(all.map(s => s.sessionId).sort()).toEqual([S1, S2]);
    const s1 = all.find(s => s.sessionId === S1)!;
    expect(s1.main).toBe(join(root, PROJECT, `${S1}.jsonl`));
    expect(s1.subagents).toHaveLength(2);
    expect(s1.subagents.some(f => f.includes(join('workflows', 'wf_1')))).toBe(true);

    expect((await findSessions({ root, session: '1111' })).map(s => s.sessionId)).toEqual([S1]);
    expect((await findSessions({ root, project: 'demo-app' })).map(s => s.sessionId)).toEqual([S1]);
    // A real folder path matches its encoded name.
    expect(encodeProjectDir('C:\\work\\demo app')).toBe('C--work-demo-app');
    expect((await findSessions({ root, project: 'C:\\work\\demo app' })).map(s => s.sessionId)).toEqual([S1]);
  });

  it('--days keeps only sessions touched in the window', async () => {
    const old = write(`${PROJECT}/${S1}.jsonl`, [user('hola')]);
    write(`${PROJECT}/${S2}.jsonl`, [user('hola')]);
    const tenDaysAgo = (Date.now() - 10 * 86_400_000) / 1000;
    utimesSync(old, tenDaysAgo, tenDaysAgo);
    expect((await findSessions({ root, days: 7 })).map(s => s.sessionId)).toEqual([S2]);
    expect(await findSessions({ root, days: 30 })).toHaveLength(2);
  });

  it('honours CLAUDE_CONFIG_DIR', () => {
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(root, 'cfg');
    try {
      expect(claudeProjectsRoot()).toBe(join(root, 'cfg', 'projects'));
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before;
    }
  });

  it('streams past broken lines, oversized lines and a torn last line', async () => {
    const big = JSON.stringify({ type: 'user', pad: 'x'.repeat(5000) });
    const p = write('f.jsonl', [{ a: 1 }, '{"broken": ', big, { a: 2 }], { tornTail: '{"a": 3, "half' });
    const stats = newReadStats();
    const got: Array<{ line: number; a: number }> = [];
    for await (const { line, entry } of readJsonl(p, { maxLineBytes: 1000, stats })) got.push({ line, a: entry.a });
    expect(got).toEqual([{ line: 1, a: 1 }, { line: 4, a: 2 }]);
    expect(stats).toEqual({ lines: 5, broken: 2, oversized: 1 });
  });

  it('anyOf drops lines as raw bytes before parsing them', async () => {
    const p = write('f.jsonl', [{ type: 'user', n: 1 }, '{not json but no needle', { type: 'assistant', n: 2 }]);
    const stats = newReadStats();
    const got: number[] = [];
    for await (const { entry } of readJsonl(p, { anyOf: ['"assistant"'], stats })) got.push(entry.n);
    expect(got).toEqual([2]);
    expect(stats.broken).toBe(0);   // the junk line was never parsed
  });

  it('a line longer than the stream chunk is reassembled', async () => {
    const long = { type: 'assistant', pad: 'y'.repeat(3 * 1024 * 1024) };
    const p = write('f.jsonl', [long, { type: 'assistant', n: 2 }]);
    const lens: number[] = [];
    for await (const { entry } of readJsonl(p)) lens.push(entry.pad ? entry.pad.length : entry.n);
    expect(lens).toEqual([3 * 1024 * 1024, 2]);
  });
});

// ─── usage ────────────────────────────────────────────────────────

describe('crbro usage', () => {
  function fixture() {
    const content = [{ type: 'text', text: `${CONTENT_MARK} ${FAKE_GH}` }];
    write(`${PROJECT}/${S1}.jsonl`, [
      user(`${CONTENT_MARK} pregunta`),
      // One response written as three lines: same id, output growing to 50.
      assistant('msg_A', 'claude-opus-5', { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 }, content),
      assistant('msg_A', 'claude-opus-5', { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 }, [toolUse('t1', 'Bash')]),
      assistant('msg_A', 'claude-opus-5', { input_tokens: 10, output_tokens: 50, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 }, [toolUse('t2', 'Bash')]),
      // A user line whose tool result carries a "usage" object of its own: not a response.
      { ...toolResult('t1', false), toolUseResult: { usage: { input_tokens: 999999, output_tokens: 999999 } } },
      '{"type":"assistant","message":{"usage":',   // broken
      assistant('msg_B', 'claude-sonnet-5', { input_tokens: 2, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 300 }, content),
      // An old-style sidechain line inside the main log counts as subagent.
      assistant('msg_C', 'claude-haiku-5', { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content, { isSidechain: true }),
      // A client-written message: no request, no tokens, not counted.
      assistant('msg_SYN', '<synthetic>', { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content),
    ]);
    write(`${PROJECT}/${S1}/subagents/agent-a1.jsonl`, [
      assistant('msg_D', 'claude-sonnet-5', { input_tokens: 3, output_tokens: 30, cache_creation_input_tokens: 7, cache_read_input_tokens: 70 }, content, { isSidechain: true }),
    ]);
    write(`${PROJECT}/${S1}/subagents/workflows/wf_1/agent-b2.jsonl`, [
      assistant('msg_E', 'claude-opus-5', { input_tokens: 4, output_tokens: 40, cache_creation_input_tokens: 8, cache_read_input_tokens: 80 }, content, { isSidechain: true }),
      assistant('msg_E', 'claude-opus-5', { input_tokens: 4, output_tokens: 44, cache_creation_input_tokens: 8, cache_read_input_tokens: 80 }, content, { isSidechain: true }),
    ], { tornTail: '{"type":"assistant","message":{"id":"msg_F","usage":{"input_tok' });
  }

  it('sums per model and per session, main apart from subagents, one count per response', async () => {
    fixture();
    const r = await collectUsage({ root });
    expect(r.sessions).toHaveLength(1);
    expect(r.files_read).toBe(3);
    const s = r.sessions[0];
    expect(s.subagent_files).toBe(2);
    expect(s.main).toEqual({
      'claude-opus-5': { input_tokens: 10, output_tokens: 50, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, messages: 1 },
      'claude-sonnet-5': { input_tokens: 2, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 300, messages: 1 },
    });
    expect(s.subagents).toEqual({
      'claude-haiku-5': { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, messages: 1 },
      'claude-sonnet-5': { input_tokens: 3, output_tokens: 30, cache_creation_input_tokens: 7, cache_read_input_tokens: 70, messages: 1 },
      'claude-opus-5': { input_tokens: 4, output_tokens: 44, cache_creation_input_tokens: 8, cache_read_input_tokens: 80, messages: 1 },
    });
    expect(r.by_model['claude-opus-5'].total).toEqual({ input_tokens: 14, output_tokens: 94, cache_creation_input_tokens: 108, cache_read_input_tokens: 1080, messages: 2 });
    expect(r.totals.main.output_tokens).toBe(70);
    expect(r.totals.subagents.output_tokens).toBe(75);
    expect(r.totals.total.messages).toBe(5);
    expect(r.by_model['<synthetic>']).toBeUndefined();
    expect(r.lines_broken).toBe(2);   // the broken line and the torn tail
  });

  it('never puts content in its output, text or JSON', async () => {
    fixture();
    const r = await collectUsage({ root });
    for (const out of [JSON.stringify(r), formatUsage(r)]) {
      expect(out).not.toContain(CONTENT_MARK);
      expect(out).not.toContain(RESULT_MARK);
      expect(out).not.toContain(INPUT_MARK);
      expect(out).not.toContain(FAKE_GH);
    }
    expect(formatUsage(r)).toContain('main');
  });

  it('pickUsage reads model and usage and never touches the content', () => {
    const message: Record<string, unknown> = { id: 'msg_X', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 2 } };
    Object.defineProperty(message, 'content', { get() { throw new Error('content was read'); }, enumerable: true });
    const entry = { type: 'assistant', message };
    Object.defineProperty(entry, 'toolUseResult', { get() { throw new Error('toolUseResult was read'); }, enumerable: true });
    const u = pickUsage(entry);
    expect(u).toEqual({ key: 'msg_X', model: 'claude-opus-5', sidechain: false, at: null, counts: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
    expect(pickUsage({ type: 'user', message: { usage: { input_tokens: 5 } } })).toBeNull();
  });

  it('a response copied into a resumed session is counted once, in the session where it happened', async () => {
    const u = (i: number, o: number) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    const s1 = write(`${PROJECT}/${S1}.jsonl`, [assistant('msg_X', 'claude-opus-5', u(10, 5), [])]);
    write(`${PROJECT}/${S2}.jsonl`, [
      assistant('msg_X', 'claude-opus-5', u(10, 5), []),   // the copy a resume writes
      assistant('msg_Y', 'claude-opus-5', u(1, 1), []),
    ]);
    const older = (Date.now() - 3600_000) / 1000;
    utimesSync(s1, older, older);
    const r = await collectUsage({ root });
    expect(r.totals.total).toMatchObject({ input_tokens: 11, output_tokens: 6, messages: 2 });
    expect(r.sessions.find(s => s.session === S1)!.main['claude-opus-5'].messages).toBe(1);
    expect(r.sessions.find(s => s.session === S2)!.main['claude-opus-5']).toMatchObject({ input_tokens: 1, messages: 1 });
  });

  it('--days counts only the responses inside the window, not the whole of an old session resumed today', async () => {
    const u = { input_tokens: 100, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 3600_000).toISOString();
    write(`${PROJECT}/${S1}.jsonl`, [
      assistant('msg_OLD', 'claude-opus-5', u, [], { timestamp: old }),
      assistant('msg_NEW', 'claude-opus-5', { ...u, output_tokens: 7 }, [], { timestamp: recent }),
    ]);
    const week = await collectUsage({ root, days: 7 });
    expect(week.totals.total).toMatchObject({ output_tokens: 7, messages: 1 });
    const all = await collectUsage({ root });
    expect(all.totals.total.messages).toBe(2);
  });

  it('an empty or missing projects folder is an empty report, not an error', async () => {
    const r = await collectUsage({ root: join(root, 'nope') });
    expect(r.sessions).toEqual([]);
    expect(formatUsage(r)).toContain('No sessions with usage data');
  });
});

// ─── postmortem ───────────────────────────────────────────────────

describe('crbro postmortem', () => {
  const REPEATED = 'Por favor revisa el fichero de configuración del servidor de producción';

  function fixture() {
    const z = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    write(`${PROJECT}/${S1}.jsonl`, [
      user(REPEATED),                                                     // 1
      assistant('m1', 'claude-opus-5', z, [toolUse('b1', 'Bash')]),       // 2
      toolResult('b1', true),                                             // 3
      assistant('m2', 'claude-opus-5', z, [toolUse('b2', 'Bash')]),       // 4
      toolResult('b2', true),                                             // 5
      assistant('m3', 'claude-opus-5', z, [toolUse('b3', 'Bash')]),       // 6
      toolResult('b3', true),                                             // 7
      user(`No, te dije que usaras pnpm; mi token es ${FAKE_GH}`),        // 8 correction + secret
      assistant('m4', 'claude-opus-5', z, [toolUse('e1', 'Edit')]),       // 9
      toolResult('e1', false),                                            // 10
      user('eso no, está mal otra vez'),                                  // 11 correction
      user(`${REPEATED}.`),                                               // 12 same request again
      user('<system-reminder>no, esto no lo escribió nadie</system-reminder>'),   // 13 harness line, ignored
      user([{ type: 'text', text: '[Request interrupted by user]' }]),    // 14 ignored
      user('no, que no', { isMeta: true }),                               // 15 meta, ignored
    ]);
    // The same request in a second session: a lesson that was never stored.
    write(`${PROJECT}/${S2}.jsonl`, [user(REPEATED)]);
    // A long session.
    const many: unknown[] = [];
    for (let i = 0; i < 61; i++) many.push(user(`ok ${i}`));   // short: not a "repeated request"
    write(`${PROJECT}/${S3}.jsonl`, many);
    // A subagent log full of "corrections" from the orchestrating model: not the person's.
    write(`${PROJECT}/${S1}/subagents/agent-a1.jsonl`, [user('no, te dije otra cosa'), user('no, eso no')]);
  }

  it('finds corrections, a failing streak, repeats within and across sessions, and a long session', async () => {
    fixture();
    const r = await runPostmortem({ root, max: 50 });
    expect(r.sessions_read).toBe(3);
    const kinds = r.findings.map(f => f.kind).sort();
    expect(kinds).toEqual(['corrections', 'failing_tool', 'long_session', 'repeated_request', 'repeated_request']);

    const corr = r.findings.find(f => f.kind === 'corrections')!;
    expect(corr.session).toBe(S1);
    expect(corr.evidence.map(e => e.line)).toEqual([8, 11]);   // the subagent's and the meta line are not counted

    const fail = r.findings.find(f => f.kind === 'failing_tool')!;
    expect(fail.lesson).toContain('Bash failed 3 times in a row');
    expect(fail.evidence.map(e => e.line)).toEqual([3, 5, 7]);
    expect(fail.evidence.every(e => e.text === undefined)).toBe(true);

    const within = r.findings.find(f => f.kind === 'repeated_request' && f.evidence.every(e => e.session === S1))!;
    expect(within.evidence.map(e => e.line)).toEqual([1, 12]);
    const across = r.findings.find(f => f.kind === 'repeated_request' && f.evidence.some(e => e.session === S2))!;
    expect(new Set(across.evidence.map(e => e.session))).toEqual(new Set([S1, S2]));
    // It opens both sessions: what a scheduled task or a saved template looks like, ranked below the rest.
    expect(across.lesson).toContain('scheduled task');
    expect(across.score).toBeLessThan(within.score);

    const long = r.findings.find(f => f.kind === 'long_session')!;
    expect(long.session).toBe(S3);
    expect(long.lesson).toContain('61 requests');
  });

  it('never shows a tool result or a tool input, and redacts the secret it quotes', async () => {
    fixture();
    const r = await runPostmortem({ root, max: 50 });
    const text = formatPostmortem(r);
    for (const out of [JSON.stringify(r), text]) {
      expect(out).not.toContain(RESULT_MARK);
      expect(out).not.toContain(INPUT_MARK);
      expect(out).not.toContain(FAKE_GH);
    }
    expect(text).toContain('[REDACTED: GitHub token]');
    expect(text).toContain('crbro_learn');
    expect(text).toContain('Nothing has been saved');
  });

  it('a request asked again mid-session in another session ranks as a real repeat', async () => {
    const ask = 'Explícame otra vez cómo se publica el paquete en npm con el token';
    write(`${PROJECT}/${S1}.jsonl`, [user('buenos días, empezamos con lo de ayer'), user(ask)]);
    write(`${PROJECT}/${S2}.jsonl`, [user('vamos con la versión nueva de la librería'), user(ask)]);
    const r = await runPostmortem({ root });
    const f = r.findings.find(x => x.kind === 'repeated_request')!;
    expect(f.lesson).toContain('2 different sessions');
    expect(f.lesson).toContain('store the answer or the procedure in CRBRO');
    expect(f.evidence.map(e => e.line)).toEqual([2, 2]);
  });

  it('--max keeps the strongest and says how many there were', async () => {
    fixture();
    const r = await runPostmortem({ root, max: 2 });
    expect(r.findings).toHaveLength(2);
    expect(r.total_findings).toBe(5);
    expect(r.findings[0].score).toBeGreaterThanOrEqual(r.findings[1].score);
    expect(formatPostmortem(r)).toContain('2 of 5');
  });

  it('writes nothing', async () => {
    fixture();
    const before = JSON.stringify(await findSessions({ root }));
    await runPostmortem({ root });
    expect(JSON.stringify(await findSessions({ root }))).toBe(before);
    expect(existsSync(join(root, '.crbro'))).toBe(false);
  });

  it('the extractors read ids, names and error flags, never input or result content', () => {
    const block: Record<string, unknown> = { type: 'tool_result', tool_use_id: 't9', is_error: true };
    Object.defineProperty(block, 'content', { get() { throw new Error('result content was read'); }, enumerable: true });
    expect(toolResults({ type: 'user', message: { content: [block] } })).toEqual([{ id: 't9', isError: true }]);
    expect(userText({ type: 'user', message: { content: [block] } })).toBe('');

    const call: Record<string, unknown> = { type: 'tool_use', id: 't9', name: 'Bash' };
    Object.defineProperty(call, 'input', { get() { throw new Error('tool input was read'); }, enumerable: true });
    const text: Record<string, unknown> = { type: 'text' };
    Object.defineProperty(text, 'text', { get() { throw new Error('assistant prose was read'); }, enumerable: true });
    expect(toolCalls({ type: 'assistant', message: { content: [text, call] } })).toEqual([{ id: 't9', name: 'Bash' }]);
  });

  it('correction patterns, Spanish and English, and what is not one', () => {
    for (const t of ['No, así no', 'te dije que no', 'Ya te lo he dicho', 'otra vez lo mismo', 'eso no', 'está mal',
      "that's wrong", 'I said use pnpm', 'not what I asked']) {
      expect(correctionLabel(t), t).not.toBeNull();
    }
    for (const t of ['no sé si funciona', 'normal', 'perfecto, sigue', 'animal', 'nothing to add']) {
      expect(correctionLabel(t), t).toBeNull();
    }
  });

  it('a correction opens the message: "eso no" mid-sentence, a late phrase or a long brief are not one', () => {
    expect(correctionLabel('Vale. Eso no es lo que pedí')).not.toBeNull();
    for (const t of [
      'Entiendo que eso no interfiere en las neuronas',
      'Invokard está creado para eso no? Hazlo también',
      'Revisa las tres landings, cambia los títulos, sube las fotos nuevas a la carpeta de siempre y comprueba los enlaces del pie; cuando acabes, dime cuánto ha costado y avísame si algo sale mal',
      'Rutina diaria. ' + 'Publica lo que toque en cada red. '.repeat(40) + 'Si algo sale mal, se informa.',
    ]) {
      expect(correctionLabel(t), t.slice(0, 40)).toBeNull();
    }
  });

  it('the desktop app resuming after a usage limit is not the person asking again', () => {
    const resume = 'Alcancé mi límite de uso mientras trabajabas, pero ya se restableció. Continúa donde lo dejaste.';
    expect(userText(user(resume))).toBe('');
  });

  it('a long session resumed over days reports its active hours, not the calendar span', async () => {
    const lines: unknown[] = [];
    // 61 requests a minute apart on day one, and one more three days later.
    for (let i = 0; i < 61; i++) lines.push(user(`ok ${i}`, { timestamp: new Date(Date.UTC(2026, 9, 1, 10, i)).toISOString() }));
    lines.push(user('ok final', { timestamp: '2026-10-04T10:00:00.000Z' }));
    write(`${PROJECT}/${S3}.jsonl`, lines);
    const r = await runPostmortem({ root });
    const long = r.findings.find(f => f.kind === 'long_session')!;
    expect(long.lesson).toContain('1.0 h of activity spread over 4 days');
    expect(long.lesson).not.toMatch(/7\d\.\d h/);
  });
});

// ─── The CLI wiring (needs the build) ─────────────────────────────

const CLI = join(__dirname, '..', 'bin', 'crbro.mjs');
const built = existsSync(join(__dirname, '..', 'dist', 'engine', 'usage.js')) && existsSync(join(__dirname, '..', 'dist', 'engine', 'postmortem.js'));

describe.skipIf(!built)('CLI', () => {
  it('usage --json and postmortem --json read CLAUDE_CONFIG_DIR/projects', () => {
    const cfg = join(root, 'cfg');
    const projects = join(cfg, 'projects');
    mkdirSync(join(projects, PROJECT), { recursive: true });
    writeFileSync(join(projects, PROJECT, `${S1}.jsonl`), [
      assistant('m1', 'claude-opus-5', { input_tokens: 5, output_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, [{ type: 'text', text: CONTENT_MARK }], { timestamp: new Date().toISOString() }),
      user(`no, te dije ${FAKE_GH}`), user('eso no'),
    ].map(e => JSON.stringify(e)).join('\n') + '\n');
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
    const u = spawnSync(process.execPath, [CLI, 'usage', '--json'], { encoding: 'utf8', env, timeout: 30000 });
    expect(u.status).toBe(0);
    const ur = JSON.parse(u.stdout);
    expect(ur.days).toBe(7);
    expect(ur.totals.total.output_tokens).toBe(6);
    expect(u.stdout).not.toContain(CONTENT_MARK);

    const p = spawnSync(process.execPath, [CLI, 'postmortem', '--days', '0'], { encoding: 'utf8', env, timeout: 30000 });
    expect(p.status).toBe(0);
    expect(p.stdout).toContain('Repeated corrections');
    expect(p.stdout).not.toContain(FAKE_GH);

    const bad = spawnSync(process.execPath, [CLI, 'usage', '--days', 'muchos'], { encoding: 'utf8', env, timeout: 30000 });
    expect(bad.status).toBe(1);
  });
});
