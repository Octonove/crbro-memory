#!/usr/bin/env node
// Agentic benchmark — see PREREGISTRO.md. A fresh Claude Code session gets a
// question whose answer lives (or does not) in a seeded CRBRO brain.
//
//   node benchmarks/agentic/run.mjs --dry                  validate everything but the model call
//   node benchmarks/agentic/run.mjs --model haiku --reps 3 [--parallel 4]
//
// Never touches credentials: if `claude` is not logged in it says so and
// stops. Never touches the user's brain: every cell gets its own copy of a
// brain seeded from tasks.json in a temporary folder.

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { scoreAnswer, aggregate, verdict } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const DIST = join(REPO, 'dist');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const DRY = process.argv.includes('--dry');
const MODEL = arg('model', 'haiku');
const REPS = Number(arg('reps', '3'));
const PARALLEL = Number(arg('parallel', '4'));
const spec = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8'));

if (!existsSync(join(DIST, 'index.js'))) { console.error('dist/ is missing: npm run build first.'); process.exit(1); }

// ── Seed one brain from tasks.json, through the product's own write path ──
const work = mkdtempSync(join(tmpdir(), 'crbro-agentic-'));
const seeded = join(work, 'seed', 'brain');
mkdirSync(seeded, { recursive: true });
{
  const { Brain } = await import(pathToFileURL(join(DIST, 'engine/brain.js')).href);
  const { Cortex } = await import(pathToFileURL(join(DIST, 'engine/cortex.js')).href);
  const { SearchEngine } = await import(pathToFileURL(join(DIST, 'search/index.js')).href);
  process.env.CRBRO_SEMANTIC = '0';
  const brain = new Brain(seeded);
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
  await engine.persist();
  // The trap must be armed, or the stale tasks measure nothing.
  for (const s of spec.seed.filter(x => x.retired_by)) {
    const hits = await engine.search(s.text, { limit: 5 });
    if (hits.some(h => h.matching_content === s.text)) { console.error(`seed error: retired fact still surfaces in recall: ${s.text}`); process.exit(1); }
  }
}

const ARMS = ['baseline', 'crbro'];
const READ_TOOLS = 'mcp__crbro__crbro_boot,mcp__crbro__crbro_recall,mcp__crbro__crbro_inspect';

function cellDir(arm, id) {
  const dir = join(work, 'cells', `${arm}-${id}`);
  mkdirSync(join(dir, 'cwd'), { recursive: true });
  let servers = {};
  if (arm === 'crbro') {
    cpSync(seeded, join(dir, 'brain'), { recursive: true });
    servers = { crbro: { command: process.execPath, args: [join(DIST, 'index.js')], env: { CRBRO_PATH: join(dir, 'brain'), CRBRO_SEMANTIC: '0', CRBRO_AUTOBACKUP: '0' } } };
  }
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: servers }));
  return dir;
}

function claudeArgs(dir, arm, { tools }) {
  return ['-p', '--model', MODEL, '--output-format', 'json', '--no-session-persistence',
    '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', join(dir, 'mcp.json'),
    '--tools', '', '--max-turns', '8',
    ...(arm === 'crbro' && tools ? ['--allowedTools', READ_TOOLS] : [])];
}

/** The prompt goes through stdin: no shell quoting between us and the question. */
function ask(dir, arm, prompt, opts = { tools: true }) {
  return new Promise(resolve => {
    const child = spawn('claude', claudeArgs(dir, arm, opts), { cwd: join(dir, 'cwd'), shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => child.kill(), 240_000);
    child.stdout.on('data', c => { out += c; });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const d = JSON.parse(out.slice(out.indexOf('{')));
        resolve({ answer: d.result ?? '', error: d.is_error ? String(d.result) : null, cost_usd: d.total_cost_usd ?? 0, turns: d.num_turns ?? 0 });
      } catch {
        resolve({ answer: '', error: `unparseable output: ${out.slice(0, 200)}`, cost_usd: 0, turns: 0 });
      }
    });
    child.stdin.end(prompt);
  });
}

const cleanup = () => { try { rmSync(work, { recursive: true, force: true }); } catch { /* temp */ } };

if (DRY) {
  const dir = cellDir('crbro', 'dry');
  console.log(`seeded brain ok · ${spec.seed.length} entries · ${spec.seed.filter(s => s.retired_by).length} retired values armed and absent from recall`);
  console.log(`tasks: ${spec.tasks.length} · arms: ${ARMS.join(', ')} · reps: ${REPS} → ${spec.tasks.length * ARMS.length * REPS} sessions + ${ARMS.length} canaries`);
  console.log(`would run: claude ${claudeArgs(dir, 'crbro', { tools: true }).map(a => (a.includes(' ') || a === '' ? JSON.stringify(a) : a)).join(' ')}  < prompt`);
  const v = spawnSync('claude', ['--version'], { shell: process.platform === 'win32', encoding: 'utf8' });
  console.log(`claude CLI: ${(v.stdout || '').trim() || 'NOT FOUND'}`);
  cleanup();
  process.exit(0);
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

// ── The cells ──
const jobs = [];
for (let rep = 0; rep < REPS; rep++) for (const arm of ARMS) for (const task of spec.tasks) jobs.push({ rep, arm, task });
const cells = [];
let next = 0;
await Promise.all(Array.from({ length: Math.max(1, PARALLEL) }, async () => {
  while (next < jobs.length) {
    const { rep, arm, task } = jobs[next++];
    const r = await ask(cellDir(arm, `${task.id}-${rep}`), arm, `${task.prompt} ${spec.suffix}`);
    const outcome = r.error ? 'wrong' : scoreAnswer(task, r.answer);
    cells.push({ rep, arm, id: task.id, kind: task.kind, outcome, answer: r.answer.slice(0, 200), error: r.error, cost_usd: r.cost_usd, turns: r.turns });
    process.stdout.write(`  ${arm.padEnd(8)} ${task.id} #${rep}  ${outcome}\n`);
  }
}));

const agg = aggregate(cells);
const v = verdict(agg, REPS);
const version = (spawnSync('claude', ['--version'], { shell: process.platform === 'win32', encoding: 'utf8' }).stdout || '').trim();
const result = { date: new Date().toISOString().slice(0, 10), model: MODEL, claude_code: version, reps: REPS, aggregate: agg, verdict: v, cells };
mkdirSync(join(HERE, '..', 'results'), { recursive: true });
const file = join(HERE, '..', 'results', `agentic-${result.date}-${MODEL}.json`);
writeFileSync(file, JSON.stringify(result, null, 2) + '\n');

console.log(`\n══ Agentic benchmark · ${MODEL} · ${version} · n=${REPS} ══`);
for (const arm of ARMS) for (const [kind, k] of Object.entries(agg[arm] || {})) {
  console.log(`  ${arm.padEnd(8)} ${kind.padEnd(15)} correct ${k.correct}/${k.n} · stale ${k.stale} · abstain ${k.abstain} · wrong ${k.wrong} · $${k.cost_usd.toFixed(4)} · ${(k.turns / k.n).toFixed(1)} turns`);
}
for (const c of v.checks) console.log(`  [${c.pass ? 'pass' : 'FAIL'}] ${c.rule}: ${JSON.stringify(c.value)}`);
console.log(`  claim allowed: ${v.claim_allowed}${v.enough_reps ? '' : ' (needs reps >= 3)'}\n  ${file}`);
cleanup();
