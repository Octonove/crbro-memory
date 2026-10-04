#!/usr/bin/env node
// Agentic benchmark — see PREREGISTRO.md. A fresh Claude Code session gets a
// question whose answer lives (or does not) in a seeded CRBRO brain.
//
//   node benchmarks/agentic/run.mjs --dry                  validate everything but the model call
//   node benchmarks/agentic/run.mjs --model haiku --reps 3 [--parallel 4]
//
// Amendment of 2026-10-04 (stale-unmarked), all optional:
//   --only stale-unmarked          run only these task kinds (comma-separated)
//   --dist <path>                  the CRBRO build under test (default: this repo's dist/);
//                                  the "before" run points it at a 2.8.0 build
//   --label before|after           appended to the results file name
//   --compare <results.json>       a "before" run of the same model and n, for check U4
//
// Sixth amendment (2026-10-04): a second case, stale-unmarked-b (project
// Tramuntana), in tasks.json `unmarked_b`, with its own brain copy and its own
// world. --only takes its kinds like any other; a task with "suffix": false is
// asked without the answer-format suffix (secondary analysis).
//
// Never touches credentials: if `claude` is not logged in it says so and
// stops. Never touches the user's brain: every cell gets its own copy of a
// brain seeded from tasks.json in a temporary folder.

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { scoreAnswer, aggregate, verdict, verdictUnmarked, UNMARKED, UNMARKED_B } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const DIST = resolve(arg('dist', join(REPO, 'dist')));
const DRY = process.argv.includes('--dry');
const MODEL = arg('model', 'haiku');
const REPS = Number(arg('reps', '3'));
const PARALLEL = Number(arg('parallel', '4'));
const LABEL = arg('label', '');
const ONLY = arg('only', '') ? new Set(arg('only', '').split(',').map(s => s.trim()).filter(Boolean)) : null;
const COMPARE = arg('compare', '');
const spec = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8'));
const TASKS = spec.tasks.filter(t => !ONLY || ONLY.has(t.kind));
// The world-and-old-memory cases. Each has its own seed, its own world and its
// own brain copy; the first case (Pelícano) is the frozen `unmarked` block,
// unchanged, and owns the kind stale-unmarked.
const BLOCKS = [
  { key: 'unmarked', kinds: [UNMARKED], ...spec.unmarked },
  ...(spec.unmarked_b ? [{ key: 'unmarked_b', ...spec.unmarked_b }] : []),
];
const blockOf = (kind) => BLOCKS.find(b => b.kinds.includes(kind)) || null;
const BLOCKS_RUN = BLOCKS.filter(b => TASKS.some(t => b.kinds.includes(t.kind)));
const WANTS_UNMARKED = BLOCKS_RUN.length > 0;
const promptOf = (task) => (task.suffix === false ? task.prompt : `${task.prompt} ${spec.suffix}`);

if (!existsSync(join(DIST, 'index.js'))) { console.error(`${DIST} has no index.js: npm run build first.`); process.exit(1); }
if (TASKS.length === 0) { console.error(`--only ${[...ONLY].join(',')} matches no task kind.`); process.exit(1); }

// ── Seed the brains from tasks.json, through the product's own write path ──
process.env.CRBRO_SEMANTIC = '0';
const { Brain } = await import(pathToFileURL(join(DIST, 'engine/brain.js')).href);
const { Cortex } = await import(pathToFileURL(join(DIST, 'engine/cortex.js')).href);
const { SearchEngine } = await import(pathToFileURL(join(DIST, 'search/index.js')).href);
const DAY = 86_400_000;
const T0 = Date.now();

const work = mkdtempSync(join(tmpdir(), 'crbro-agentic-'));
const seeded = join(work, 'seed', 'brain');
// Each stale-unmarked brain is another copy: the original seed plus that
// case's aged facts. The twelve original tasks keep running on a brain that
// is byte-for-byte the one they were frozen with.
const seededOf = (block) => join(work, `seed-${block.key}`, 'brain');

async function seedBrain(dir, { block = null } = {}) {
  mkdirSync(dir, { recursive: true });
  const brain = new Brain(dir);
  await brain.initialize();
  const cortex = new Cortex(brain);
  const engine = new SearchEngine(brain);
  await engine.init();
  cortex.setIndexer(n => engine.indexNeuron(n));
  for (const s of spec.seed) {
    await cortex.learn(s.topic, s.type, s.text, { domain: s.domain, rationale: s.rationale });
    // A retired value is the trap: the old telling stays in the file, superseded.
    if (s.retired_by) await cortex.learn(s.topic, 'fact', s.retired_by, { domain: s.domain, supersedes: [s.text] });
  }
  if (block) {
    const neurons = new Set();
    for (const s of block.seed) {
      const r = await cortex.learn(s.topic, s.type, s.text, { domain: s.domain });
      neurons.add(r.neuron.id);
    }
    // Ageing goes through the file, not the API: no CRBRO writes a past date,
    // and the same three raw fields (added, verified, shelf_life) must reach
    // the 2.8.0 build — which ignores the last two — and the build under test.
    // Then the neuron is re-indexed, so the index carries the aged date too.
    for (const id of neurons) {
      const file = brain.paths.neuron(id);
      const n = JSON.parse(readFileSync(file, 'utf8'));
      for (const s of block.seed.filter(x => x.age_days > 0 || x.shelf_life)) {
        const f = n.facts.find(x => x.text === s.text);
        if (!f) continue;
        if (s.age_days > 0) {
          const when = new Date(T0 - s.age_days * DAY).toISOString();
          f.added = when;
          f.verified = when;
        }
        if (s.shelf_life) f.shelf_life = s.shelf_life;
      }
      writeFileSync(file, JSON.stringify(n, null, 2));
      await engine.indexNeuron(n);
    }
  }
  await engine.persist();
  return engine;
}

{
  const engine = await seedBrain(seeded);
  // The trap must be armed, or the stale tasks measure nothing.
  for (const s of spec.seed.filter(x => x.retired_by)) {
    const hits = await engine.search(s.text, { limit: 5 });
    if (hits.some(h => h.matching_content === s.text)) { console.error(`seed error: retired fact still surfaces in recall: ${s.text}`); process.exit(1); }
  }
}
for (const block of BLOCKS_RUN) {
  const engine = await seedBrain(seededOf(block), { block });
  // The opposite trap: the old value must be LIVE, findable and old. The check
  // reads the whole answer as text, so it holds whatever shape a later build
  // gives recall (a possibly_stale block included).
  for (const s of block.seed.filter(x => x.age_days > 0)) {
    const said = JSON.stringify(await engine.search(s.text, { limit: 5 }));
    const day = new Date(T0 - s.age_days * DAY).toISOString().slice(0, 10);
    if (!said.includes(JSON.stringify(s.text).slice(1, -1)) || !said.includes(day)) {
      console.error(`seed error (${block.key}): aged fact not served by recall with its old date (${day}): ${s.text}`); process.exit(1);
    }
  }
}

const ARMS = ['baseline', 'crbro'];
const READ_TOOLS = 'mcp__crbro__crbro_boot,mcp__crbro__crbro_recall,mcp__crbro__crbro_inspect';
// stale-unmarked only: the world is a file in the cell, and BOTH arms can read
// it. Nothing that writes, nothing that runs a command.
const FILE_TOOLS = 'Read,Glob,Grep';

function cellDir(arm, id, { block = null } = {}) {
  const dir = join(work, 'cells', `${arm}-${id}`);
  mkdirSync(join(dir, 'cwd'), { recursive: true });
  let servers = {};
  if (arm === 'crbro') {
    cpSync(block ? seededOf(block) : seeded, join(dir, 'brain'), { recursive: true });
    servers = { crbro: { command: process.execPath, args: [join(DIST, 'index.js')], env: { CRBRO_PATH: join(dir, 'brain'), CRBRO_SEMANTIC: '0', CRBRO_AUTOBACKUP: '0' } } };
  }
  // A world file may sit in a subfolder (config/…, docs/…): still inside cwd.
  if (block) for (const [name, body] of Object.entries(block.world)) {
    const file = join(dir, 'cwd', name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: servers }));
  return dir;
}

function claudeArgs(dir, arm, { tools, files = false }) {
  const allowed = [arm === 'crbro' && tools ? READ_TOOLS : '', files ? FILE_TOOLS : ''].filter(Boolean).join(',');
  return ['-p', '--model', MODEL, '--no-session-persistence',
    // stream-json only where file tools exist: it is how every Read/Glob/Grep
    // the agent makes is seen, and audited, below.
    ...(files ? ['--output-format', 'stream-json', '--verbose'] : ['--output-format', 'json']),
    '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', join(dir, 'mcp.json'),
    '--tools', files ? FILE_TOOLS : '', '--max-turns', files ? '12' : '8', '--disable-slash-commands',
    ...(allowed ? ['--allowedTools', allowed] : [])];
}

/**
 * `--setting-sources project` keeps the user's settings and hooks out, but NOT
 * the user's CLAUDE.md: on 2026-10-03 the first run's canary caught the global
 * CLAUDE.md (Orchestrator, Card Zero, the crbro tool names) in the baseline arm
 * and aborted. `--safe-mode` removes it but also drops the --mcp-config server,
 * so the crbro arm lost its tools. These two variables remove the memory files
 * and nothing else; `--disable-slash-commands` keeps the user's skills (among
 * them the zero-crbro card) from helping the crbro arm.
 */
const CELL_ENV = { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };

/** One JSON object (--output-format json) or one per line (stream-json): the last `result` speaks. */
function parseOutput(out) {
  const objs = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { objs.push(JSON.parse(t)); } catch { /* a partial line */ }
  }
  let result = [...objs].reverse().find(o => o && o.type === 'result');
  if (!result) result = JSON.parse(out.slice(out.indexOf('{')));
  const uses = [];
  for (const o of objs) {
    if (o?.type !== 'assistant') continue;
    for (const c of o.message?.content || []) if (c?.type === 'tool_use') uses.push({ name: String(c.name), input: c.input || {} });
  }
  return { result, uses };
}

/**
 * Every file the agent touched must be inside its own cell's working
 * directory. Reading the user's ~/.crbro or ~/.claude would contaminate the
 * baseline arm; reading the cell's brain folder directly would let the crbro
 * arm bypass what recall says; reading this repository would hand it the
 * answers. Any of them is a leak, and a leak aborts the run unpublished.
 */
function leaksOf(cwd, uses) {
  const out = [];
  for (const u of uses) {
    if (u.name.startsWith('mcp__')) continue;
    if (!FILE_TOOLS.split(',').includes(u.name)) { out.push(`${u.name}: tool not allowed`); continue; }
    const targets = [u.input.file_path, u.input.path, u.name === 'Glob' ? u.input.pattern : null].filter(Boolean).map(String);
    for (const p of targets) {
      if (p.startsWith('~')) { out.push(`${u.name}: ${p}`); continue; }
      if (u.name === 'Glob' && p === u.input.pattern && !/^([a-zA-Z]:|[\\/])/.test(p)) continue;  // a relative pattern stays in cwd
      const rel = relative(cwd, resolve(cwd, p));
      if (rel.startsWith('..') || isAbsolute(rel)) out.push(`${u.name}: ${p}`);
    }
  }
  return out;
}

/** The prompt goes through stdin: no shell quoting between us and the question. */
function ask(dir, arm, prompt, opts = { tools: true }) {
  return new Promise(resolveAsk => {
    const cwd = join(dir, 'cwd');
    const child = spawn('claude', claudeArgs(dir, arm, opts), { cwd, shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: CELL_ENV });
    let out = '';
    const timer = setTimeout(() => child.kill(), 240_000);
    child.stdout.on('data', c => { out += c; });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const { result: d, uses } = parseOutput(out);
        const files = opts.files ? { tool_calls: uses.map(u => ({ name: u.name, target: String(u.input.file_path || u.input.path || u.input.pattern || '').slice(0, 200) })), leaks: leaksOf(cwd, uses) } : {};
        resolveAsk({ answer: d.result ?? '', error: d.is_error ? String(d.result) : null, cost_usd: d.total_cost_usd ?? 0, turns: d.num_turns ?? 0, ...files });
      } catch {
        resolveAsk({ answer: '', error: `unparseable output: ${out.slice(0, 200)}`, cost_usd: 0, turns: 0, ...(opts.files ? { tool_calls: [], leaks: [] } : {}) });
      }
    });
    child.stdin.end(prompt);
  });
}

const cleanup = () => { try { rmSync(work, { recursive: true, force: true }); } catch { /* temp */ } };

/** The build under test, said in every result: a before/after comparison is only as good as this line. */
function buildInfo() {
  const root = join(DIST, '..');
  let version = '?';
  try { version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version; } catch { /* not a package root */ }
  const git = (...a) => (spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' }).stdout || '').trim();
  return { version, commit: git('rev-parse', 'HEAD') || '?', dirty: git('status', '--porcelain', '--untracked-files=no') !== '', dist: DIST };
}

if (DRY) {
  const dir = cellDir('crbro', 'dry');
  console.log(`seeded brain ok · ${spec.seed.length} entries · ${spec.seed.filter(s => s.retired_by).length} retired values armed and absent from recall`);
  for (const block of BLOCKS_RUN) {
    const u = block.seed;
    console.log(`${block.key} brain ok · kinds ${block.kinds.join(', ')} · +${u.length} entries · ${u.filter(s => s.age_days > 0).length} aged facts live in recall with their old date · world: ${Object.keys(block.world).join(', ')}`);
    const ud = cellDir('crbro', `dry-${block.key}`, { block });
    for (const name of Object.keys(block.world)) if (!existsSync(join(ud, 'cwd', name))) { console.error(`world file not written: ${name}`); process.exit(1); }
    console.log(`would run (${block.key}): claude ${claudeArgs(ud, 'crbro', { tools: true, files: true }).map(a => (a.includes(' ') || a === '' ? JSON.stringify(a) : a)).join(' ')}  < prompt`);
  }
  const free = TASKS.filter(t => t.suffix === false);
  if (free.length) console.log(`without the suffix: ${free.map(t => t.id).join(', ')} · e.g. "${promptOf(free[0])}"`);
  console.log(`task ids: ${TASKS.map(t => t.id).join(', ')}`);
  console.log(`tasks: ${TASKS.length} · arms: ${ARMS.join(', ')} · reps: ${REPS} → ${TASKS.length * ARMS.length * REPS} sessions + ${ARMS.length} canaries${WANTS_UNMARKED ? ` + ${ARMS.length} read canaries` : ''}`);
  console.log(`would run: claude ${claudeArgs(dir, 'crbro', { tools: true }).map(a => (a.includes(' ') || a === '' ? JSON.stringify(a) : a)).join(' ')}  < prompt`);
  console.log(`build under test: ${JSON.stringify(buildInfo())}`);
  const v = spawnSync('claude', ['--version'], { shell: process.platform === 'win32', encoding: 'utf8' });
  console.log(`claude CLI: ${(v.stdout || '').trim() || 'NOT FOUND'}`);
  cleanup();
  process.exit(0);
}

let compareAgg = null;
if (COMPARE) {
  const prev = JSON.parse(readFileSync(resolve(COMPARE), 'utf8'));
  if (prev.model !== MODEL || prev.reps !== REPS) console.error(`warning: --compare is ${prev.model} n=${prev.reps}, this run is ${MODEL} n=${REPS}; U4 needs the same model and n.`);
  compareAgg = prev.model === MODEL ? prev.aggregate : null;
}

// ── Preflight: logged in? ──
const pre = await ask(cellDir('baseline', 'preflight'), 'baseline', 'Responde solo: ok');
if (pre.error) {
  console.error(`claude is not usable here: ${pre.error}\nLog in by hand (claude /login) and run again. This script never handles credentials.`);
  cleanup();
  process.exit(2);
}

// ── Canary: contamination aborts the run ──
for (const arm of ARMS) {
  const r = await ask(cellDir(arm, 'canary'), arm, spec.canary.prompt, { tools: false });
  let got = null;
  try { got = JSON.parse((r.answer.match(/\{[^}]*\}/) || [''])[0]); } catch { /* below */ }
  const want = spec.canary.expected[arm];
  const ok = got && Object.keys(want).every(k => got[k] === want[k]);
  console.log(`canary ${arm}: ${ok ? 'clean' : 'CONTAMINATED'}  ${JSON.stringify(got)}`);
  if (!ok) { console.error('Aborting: a contaminated arm measures the leak, not the product.'); cleanup(); process.exit(3); }
}

// ── Read canary (stale-unmarked): both arms must be able to read their own
// working directory, and nothing else. If an arm cannot read, the tasks would
// measure the permission system, not the memory. ──
if (WANTS_UNMARKED) {
  for (const arm of ARMS) {
    const dir = cellDir(arm, 'canary-read');
    const token = `CANARIO-${randomUUID().slice(0, 8)}`;
    writeFileSync(join(dir, 'cwd', spec.unmarked.read_canary.file), `${token}\n`);
    const r = await ask(dir, arm, spec.unmarked.read_canary.prompt, { tools: true, files: true });
    const ok = !r.error && r.answer.includes(token) && r.leaks.length === 0;
    console.log(`read canary ${arm}: ${ok ? 'clean' : 'FAILED'}  ${r.error || r.answer.slice(0, 80)}${r.leaks.length ? ` leaks: ${r.leaks.join('; ')}` : ''}`);
    if (!ok) { console.error('Aborting: an arm that cannot read its own folder, or reads outside it, measures the harness.'); cleanup(); process.exit(3); }
  }
}

// ── The cells ──
const jobs = [];
for (let rep = 0; rep < REPS; rep++) for (const arm of ARMS) for (const task of TASKS) jobs.push({ rep, arm, task });
const cells = [];
let next = 0;
await Promise.all(Array.from({ length: Math.max(1, PARALLEL) }, async () => {
  while (next < jobs.length) {
    const { rep, arm, task } = jobs[next++];
    const block = blockOf(task.kind);
    const unmarked = !!block;
    const opts = { tools: true, files: unmarked };
    let r = await ask(cellDir(arm, `${task.id}-${rep}`, { block }), arm, promptOf(task), opts);
    // An API error is not an answer: one retry on a fresh cell (amendment 3,
    // 2026-10-03). A second error still counts as wrong, and both are kept.
    let retried = null;
    let leaks = r.leaks || [];
    if (r.error) { retried = r.error; r = await ask(cellDir(arm, `${task.id}-${rep}-retry`, { block }), arm, promptOf(task), opts); leaks = [...leaks, ...(r.leaks || [])]; }
    const outcome = r.error ? 'wrong' : scoreAnswer(task, r.answer);
    cells.push({ rep, arm, id: task.id, kind: task.kind, outcome, answer: r.answer.slice(0, 200), error: r.error, retried_after: retried, cost_usd: r.cost_usd, turns: r.turns,
      ...(unmarked ? { tool_calls: r.tool_calls, leaks } : {}) });
    process.stdout.write(`  ${arm.padEnd(8)} ${task.id} #${rep}  ${outcome}${leaks.length ? '  LEAK' : ''}\n`);
  }
}));

const leaked = cells.filter(c => c.leaks && c.leaks.length);
if (leaked.length) {
  console.error(`\nAborting: ${leaked.length} cell(s) read outside their own folder. Nothing is written to results/.`);
  for (const c of leaked) console.error(`  ${c.arm} ${c.id} #${c.rep}: ${c.leaks.join('; ')}`);
  cleanup();
  process.exit(3);
}

const agg = aggregate(cells);
const kindsRun = new Set(TASKS.map(t => t.kind));
const ORIGINAL = ['memory', 'stale', 'control-prompt', 'control-absent'];
// The four original thresholds are judged only on a run that had all four
// original kinds; a partial run says nothing about them.
const v = ORIGINAL.every(k => kindsRun.has(k)) ? verdict(agg, REPS) : null;
const vu = kindsRun.has(UNMARKED) ? verdictUnmarked(agg, REPS, { before: compareAgg, original: v }) : null;
// Sixth amendment: the same five checks judge the second case on its own.
// stale-unmarked-b-free and old-true-b are secondary: reported, never judged.
const vub = kindsRun.has(UNMARKED_B) ? verdictUnmarked(agg, REPS, { before: compareAgg, original: v, kind: UNMARKED_B }) : null;
const version = (spawnSync('claude', ['--version'], { shell: process.platform === 'win32', encoding: 'utf8' }).stdout || '').trim();
const result = { date: new Date().toISOString().slice(0, 10), model: MODEL, claude_code: version, reps: REPS, label: LABEL || undefined,
  only: ONLY ? [...ONLY] : undefined, crbro: buildInfo(), compared_with: COMPARE || undefined,
  aggregate: agg, verdict: v, verdict_unmarked: vu, verdict_unmarked_b: vub || undefined, cells };
mkdirSync(join(HERE, '..', 'results'), { recursive: true });
const file = join(HERE, '..', 'results', `agentic-${result.date}-${MODEL}${LABEL ? `-${LABEL}` : ''}.json`);
writeFileSync(file, JSON.stringify(result, null, 2) + '\n');

console.log(`\n══ Agentic benchmark · ${MODEL} · ${version} · n=${REPS} · CRBRO ${result.crbro.version} ${result.crbro.commit.slice(0, 7)}${result.crbro.dirty ? ' (dirty)' : ''} ══`);
for (const arm of ARMS) for (const [kind, k] of Object.entries(agg[arm] || {})) {
  console.log(`  ${arm.padEnd(8)} ${kind.padEnd(15)} correct ${k.correct}/${k.n} · stale ${k.stale}${k.hedged ? ` · hedged ${k.hedged}` : ''} · abstain ${k.abstain} · wrong ${k.wrong} · $${k.cost_usd.toFixed(4)} · ${(k.turns / k.n).toFixed(1)} turns`);
}
if (v) {
  for (const c of v.checks) console.log(`  [${c.pass ? 'pass' : 'FAIL'}] ${c.rule}: ${JSON.stringify(c.value)}`);
  console.log(`  claim allowed: ${v.claim_allowed}${v.enough_reps ? '' : ' (needs reps >= 3)'}`);
}
for (const x of [vu, vub].filter(Boolean)) {
  for (const c of x.checks) console.log(`  [${c.pass === null ? 'n/a ' : c.pass ? 'pass' : 'FAIL'}] ${x.kind} ${c.id} ${c.rule}: ${JSON.stringify(c.value)}`);
  console.log(`  ${x.kind} claim allowed: ${x.claim_allowed}${x.enough_reps ? '' : ' (needs reps >= 3)'}`);
}
console.log(`  ${file}`);
cleanup();
