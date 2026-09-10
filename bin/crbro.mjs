#!/usr/bin/env node

// ─── CRBRO CLI ───────────────────────────────────────────────────
// Command-line interface for CRBRO memory system
// Supports: init, status, secret, mine, setup-miner, miner-status,
//           remove-miner, and MCP server mode (default)

import { platform, homedir } from 'os';
import { join, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// The release that is running, read from the package itself. The manifest
// version stamps the brain format and has not moved since 1.0.0, so showing
// only that one told everyone they were on 1.0.0 forever.
function pkgVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

const args = process.argv.slice(2);
const command = args[0];

// ─── IDE Detection ──────────────────────────────────────────────
const IDE_CONFIGS = [
  {
    name: 'Antigravity (Google Gemini)',
    id: 'antigravity',
    configPath: () => join(homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
    configFormat: 'mcpServers',
  },
  {
    name: 'Cursor',
    id: 'cursor',
    configPath: () => join(homedir(), '.cursor', 'mcp.json'),
    configFormat: 'mcpServers',
  },
  {
    name: 'Windsurf',
    id: 'windsurf',
    configPath: () => join(homedir(), '.windsurf', 'mcp.json'),
    configFormat: 'mcpServers',
  },
  {
    name: 'Claude Desktop',
    id: 'claude-desktop',
    configPath: () => {
      if (platform() === 'win32') {
        return join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
      }
      return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    },
    configFormat: 'mcpServers',
  },
  {
    name: 'Claude Code (user scope)',
    id: 'claude-code',
    configPath: () => join(homedir(), '.claude.json'),
    configFormat: 'mcpServers',
  },
  {
    name: 'VS Code + Continue',
    id: 'continue',
    configPath: () => join(homedir(), '.continue', 'config.json'),
    configFormat: 'mcpServers',
  },
  {
    name: 'ChatGPT Desktop',
    id: 'chatgpt',
    configPath: () => {
      if (platform() === 'win32') {
        return join(process.env.APPDATA || '', 'ChatGPT', 'mcp_config.json');
      }
      return join(homedir(), 'Library', 'Application Support', 'ChatGPT', 'mcp_config.json');
    },
    configFormat: 'mcpServers',
  },
];

function detectIDEs() {
  const detected = [];
  for (const ide of IDE_CONFIGS) {
    try {
      const configPath = ide.configPath();
      if (existsSync(configPath)) {
        detected.push({ ...ide, configPath: configPath, exists: true });
      } else {
        // Check if the parent directory exists (IDE installed but no config yet)
        const parentDir = configPath.split(/[/\\]/).slice(0, -1).join(platform() === 'win32' ? '\\' : '/');
        if (existsSync(parentDir)) {
          detected.push({ ...ide, configPath: configPath, exists: false });
        }
      }
    } catch { /* skip */ }
  }
  return detected;
}

function generateMCPSnippet(envVars) {
  return JSON.stringify({
    "crbro": {
      "command": "npx",
      "args": ["-y", "crbro-memory"],
      ...(envVars ? { "env": envVars } : {})
    }
  }, null, 2);
}

// ─── Commands ───────────────────────────────────────────────────

// ─── Semantic recall: install, download, embed ──────────────────────
// Installed by `init` since 1.16 (skip with --no-semantic, turn off with
// CRBRO_SEMANTIC=0). The runtime (~380 MB) and the model (~118 MB) live in
// ~/.crbro/.semantic once per machine, outside the package.
async function semanticInstall(sem) {
  const { spawnSync } = await import('child_process');
  const fs = await import('fs');
  const os = await import('os');
  const home = sem.semanticHome();
  fs.mkdirSync(home, { recursive: true });
  const pkg = join(home, 'package.json');
  if (!fs.existsSync(pkg)) {
    fs.writeFileSync(pkg, JSON.stringify({ name: 'crbro-semantic', private: true }, null, 2));
  }
  if (!sem.resolveRuntime()) {
    console.log(`  ⬇️  Installing transformers.js into ${home} (~380 MB with onnxruntime)...`);
    const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', '@huggingface/transformers@3'],
      { cwd: home, stdio: 'inherit', shell: true });
    if (r.status !== 0) return false;
  }
  const st = sem.semanticStatus();
  if (!st.model_downloaded) {
    console.log(`  ⬇️  Downloading the model (${st.model}, ~118 MB)...`);
    const idx = new sem.SemanticIndex(fs.mkdtempSync(join(os.tmpdir(), 'crbro-warm-')));
    await idx.upsert([{ id: 'warm', text: 'hello' }]);   // the first use downloads and caches it
  }
  return true;
}

async function semanticBuild() {
  process.env.CRBRO_SEMANTIC = '1';
  const [{ Brain }, { SearchEngine }] = await Promise.all([
    import('../dist/engine/brain.js'),
    import('../dist/search/index.js'),
  ]);
  const brain = new Brain();
  const engine = new SearchEngine(brain);
  const started = Date.now();
  await engine.init();            // loads the stored vectors: unchanged lines are not embedded twice
  const chunks = await engine.rebuild();
  await engine.awaitEmbeddings();
  await engine.persist();
  return { chunks, vectors: engine.semanticCount(), seconds: ((Date.now() - started) / 1000).toFixed(1) };
}

if (command === 'init') {
  // ─── Initialize brain + IDE detection ──────────────────────────
  import('../dist/engine/brain.js').then(async ({ Brain }) => {
    const brain = new Brain();
    const manifest = await brain.initialize();

    console.log('');
    console.log('  🧠 CRBRO brain initialized!');
    console.log(`     Path: ${manifest.brain_path}`);
    console.log('');

    // Detect IDEs
    const ides = detectIDEs();

    if (ides.length > 0) {
      console.log('  📡 Detected IDEs:');
      console.log('');
      for (const ide of ides) {
        const status = ide.exists ? '✅ config exists' : '📝 needs config';
        console.log(`     ${ide.name}: ${status}`);
        console.log(`       → ${ide.configPath}`);
      }
      console.log('');
      console.log('  Add this to your MCP config (inside "mcpServers"):');
    } else {
      console.log('  ⚠️  No IDE detected. Add this to your MCP config manually:');
    }

    console.log('');
    console.log('  ' + generateMCPSnippet().split('\n').join('\n  '));
    // Semantic recall, installed by default since 1.16: once per machine,
    // about 500 MB on disk, ~0.5 GB of RAM while a server runs.
    const skipSemantic = args.includes('--no-semantic')
      || ['0', 'off', 'false'].includes(String(process.env.CRBRO_SEMANTIC || '').toLowerCase());
    console.log('');
    if (skipSemantic) {
  console.log('    npx crbro-memory semantic status  Semantic recall (installed by init; --no-semantic skips it): status | install | build');
    } else {
      console.log('  🧭 Semantic recall: installing (once per machine, ~500 MB)...');
      try {
        const sem = await import('../dist/search/semantic.js');
        const ok = await semanticInstall(sem);
        if (ok) {
          const r = await semanticBuild();
          console.log(`  ✅ Semantic recall ready · ${r.vectors} lines embedded in ${r.seconds}s · CRBRO_SEMANTIC=0 turns it off`);
        } else {
          console.log('  ⚠️  Could not install it; recall stays keyword-only. Retry: npx crbro-memory semantic install');
        }
      } catch (err) {
        console.log(`  ⚠️  Semantic recall not installed (${err instanceof Error ? err.message : err}); recall stays keyword-only.`);
      }
    }
    console.log('');
    console.log('  Next steps:');
    console.log('    1. Add the config above to your IDE\'s MCP settings');
    console.log('    2. (Optional) npx crbro-memory setup-miner');
    console.log('    3. Restart your IDE — CRBRO boots automatically!');
    console.log('');
  }).catch(console.error);

} else if (command === 'status') {
  // ─── Show brain status ─────────────────────────────────────────
  import('../dist/engine/brain.js').then(async ({ Brain }) => {
    const brain = new Brain();
    try {
      const manifest = await brain.getManifest();
      console.log('');
      console.log('  🧠 CRBRO Brain Status');
      console.log('  ─────────────────────');
      console.log(`  CRBRO:           ${pkgVersion()}`);
      console.log(`  Brain format:    ${manifest.version}`);
      console.log(`  Path:            ${manifest.brain_path}`);
      console.log(`  Neurons:         ${manifest.total_neurons}`);
      console.log(`  Synapses:        ${manifest.total_synapses}`);
      console.log(`  Sessions:        ${manifest.total_sessions}`);
      console.log(`  Last Boot:       ${manifest.last_boot || 'never'}`);
      console.log(`  Last Consolidate: ${manifest.last_consolidation || 'never'}`);
      console.log('');

      // Show detected IDEs
      const ides = detectIDEs();
      if (ides.length > 0) {
        console.log('  📡 Connected IDEs:');
        for (const ide of ides) {
          console.log(`     ${ide.exists ? '✅' : '⚠️ '} ${ide.name}`);
        }
        console.log('');
      }
    } catch {
      console.log('');
      console.log('  🧠 CRBRO brain not initialized.');
      console.log('     Run: npx crbro-memory init');
      console.log('');
    }
  }).catch(console.error);

} else if (command === 'activate') {
  // ─── Legacy command (pre-1.4.0) — CRBRO is now fully free ──────
  console.log('');
  console.log('  ✅ Good news: since v1.4.0 CRBRO is fully free.');
  console.log('     All 15 tools are available — no license key needed.');
  console.log('');

} else if (command === 'mine') {
  // ─── One-shot mining ───────────────────────────────────────────
  const targetDir = args[1];

  import('../dist/miner/index.js').then(async ({ Miner }) => {
    console.log('');
    console.log('  ⛏️  CRBRO Miner — Scanning for knowledge...');
    console.log('');

    const miner = new Miner();
    const result = await miner.mine(targetDir);

    console.log('  ────────────────────────────────');
    console.log(`  Files scanned:      ${result.scanned}`);
    console.log(`  New files mined:    ${result.new_files}`);
    console.log(`  Neurons created:    ${result.neurons_created}`);
    console.log(`  Neurons updated:    ${result.neurons_updated}`);
    console.log(`  Facts added:        ${result.facts_added}`);
    console.log(`  Decisions found:    ${result.decisions_added}`);

    if (result.technologies_found.length > 0) {
      console.log(`  Technologies:       ${result.technologies_found.slice(0, 10).join(', ')}`);
    }

    if (result.errors.length > 0) {
      console.log('');
      console.log('  ⚠️  Errors:');
      for (const err of result.errors.slice(0, 5)) {
        console.log(`     ${err}`);
      }
    }

    console.log('');
  }).catch(console.error);

} else if (command === 'setup-miner') {
  // ─── Setup automatic mining ────────────────────────────────────
  import('../dist/miner/scheduler.js').then(async ({ setupScheduler }) => {
    console.log('');
    console.log('  ⏰ Setting up CRBRO Auto-Miner...');
    console.log('');

    const result = await setupScheduler();
    console.log(result.message);
    console.log('');
  }).catch(console.error);

} else if (command === 'miner-status') {
  // ─── Check miner status ────────────────────────────────────────
  Promise.all([
    import('../dist/miner/scheduler.js'),
    import('../dist/miner/index.js'),
  ]).then(async ([{ getSchedulerStatus }, { Miner }]) => {
    console.log('');
    console.log('  ⛏️  CRBRO Miner Status');
    console.log('  ─────────────────────');

    // Scheduler status
    const schedStatus = await getSchedulerStatus();
    console.log(`  Scheduler:   ${schedStatus.installed ? '✅ Installed' : '❌ Not installed'}`);
    console.log(`  Platform:    ${schedStatus.platform}`);
    if (schedStatus.details) {
      console.log(`  Details:     ${schedStatus.details}`);
    }

    // Miner state
    const miner = new Miner();
    const status = await miner.getStatus();
    console.log('');
    console.log(`  Last run:    ${status.state.last_run || 'never'}`);
    console.log(`  Total mined: ${status.state.total_mined} files`);
    console.log(`  Tracked:     ${Object.keys(status.state.mined_files).length} files`);
    console.log('');

    if (status.detected_dirs.length > 0) {
      console.log('  📂 Scan directories:');
      for (const dir of status.detected_dirs) {
        console.log(`     ${dir}`);
      }
    } else {
      console.log('  ⚠️  No IDE directories detected.');
    }
    console.log('');
  }).catch(console.error);

} else if (command === 'remove-miner') {
  // ─── Remove automatic mining ───────────────────────────────────
  import('../dist/miner/scheduler.js').then(async ({ removeScheduler }) => {
    const result = await removeScheduler();
    console.log('');
    console.log(result.success ? `  ✅ ${result.message}` : `  ❌ ${result.message}`);
    console.log('');
  }).catch(console.error);

} else if (command === 'reindex') {
  // ─── Rebuild the search index from the cortex ──────────────────
  Promise.all([
    import('../dist/engine/brain.js'),
    import('../dist/search/index.js'),
  ]).then(async ([{ Brain }, { SearchEngine }]) => {
    const brain = new Brain();
    const engine = new SearchEngine(brain);

    console.log('');
    console.log('  🔁 Rebuilding the CRBRO search index...');
    const started = Date.now();
    const indexed = await engine.rebuild();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    console.log('');
    console.log(`  ✅ ${indexed} chunks indexed in ${seconds}s`);
    console.log('     Every fact, decision and pattern is now searchable on its own,');
    console.log('     so a big neuron is no longer buried by short ones.');
    console.log('');
  }).catch(console.error);

} else if (command === 'semantic') {
  // ─── Semantic recall: status | install | build ─────────────────
  const sub = args[1];
  import('../dist/search/semantic.js').then(async (sem) => {
    if (sub === 'install') {
      console.log('');
      const ok = await semanticInstall(sem);
      if (!ok) {
        console.log('  ❌ npm install failed. Nothing else changed.');
        process.exit(1);
      }
      const r = await semanticBuild();
      console.log(`  ✅ Semantic recall ready · ${r.chunks} chunks indexed · ${r.vectors} vectors · ${r.seconds}s`);
      console.log('     It is on whenever this runtime is present; CRBRO_SEMANTIC=0 turns it off.');
      console.log('');
    } else if (sub === 'build') {
      const st = sem.semanticStatus();
      if (!st.installed) {
        console.log('');
        console.log('  ❌ Runtime not installed. Run: npx crbro-memory semantic install');
        console.log('');
        return;
      }
      console.log('');
      console.log('  🧭 Embedding the brain...');
      const r = await semanticBuild();
      console.log(`  ✅ ${r.chunks} chunks indexed · ${r.vectors} vectors stored · ${r.seconds}s`);
      console.log('     From now on each new line is embedded when it is saved.');
      console.log('');
    } else {
      const st = sem.semanticStatus();
      const enabled = st.enabled
        ? (st.mode === 'forced' ? '✅ on (CRBRO_SEMANTIC=1)' : '✅ on (installed; CRBRO_SEMANTIC=0 turns it off)')
        : (st.mode === 'disabled' ? '⚪ off (CRBRO_SEMANTIC=0)' : '⚪ off (not installed)');
      console.log('');
      console.log('  🧭 CRBRO semantic recall');
      console.log('  ────────────────────────');
      console.log(`  Runtime:  ${st.installed ? '✅ installed' : '❌ not installed  →  npx crbro-memory init  (or: semantic install)'}`);
      console.log(`  Model:    ${st.model}${st.model_downloaded ? '' : '  (downloads on first use)'}`);
      console.log(`  Enabled:  ${enabled}`);
      console.log(`  Home:     ${st.home}`);
      console.log('');
    }
  }).catch(console.error);

} else if (command === 'eval') {
  // ─── Measure retrieval quality against a query set ─────────────
  //
  // Without a number you cannot tell a fix from a feeling. The file is
  // .crbro/.eval/queries.json — a list of { query, expect_neuron } and
  // optionally expect_contains, the substring the matched fact should carry.
  Promise.all([
    import('../dist/engine/brain.js'),
    import('../dist/search/index.js'),
    import('fs/promises'),
  ]).then(async ([{ Brain }, { SearchEngine }, fsp]) => {
    const brain = new Brain();
    const evalPath = join(brain.paths.root, '.eval', 'queries.json');

    let queries;
    try {
      queries = JSON.parse(await fsp.readFile(evalPath, 'utf-8'));
    } catch {
      console.log('');
      console.log(`  No query set found at ${evalPath}`);
      console.log('  Create it as a JSON array, for example:');
      console.log('');
      console.log('  [');
      console.log('    { "query": "how we deploy the api", "expect_neuron": "project_octochat",');
      console.log('      "expect_contains": "Cloud Run" }');
      console.log('  ]');
      console.log('');
      console.log('  Build it from facts you already saved: take six or eight words');
      console.log('  out of a real fact and name the neuron that holds it.');
      console.log('');
      return;
    }

    const engine = new SearchEngine(brain);
    await engine.init();

    let atOne = 0, atThree = 0, reciprocal = 0, contentOk = 0;
    const misses = [];

    for (const q of queries) {
      const results = await engine.search(q.query, { limit: 10 });
      const rank = results.findIndex(r => r.neuron_id === q.expect_neuron);

      if (rank === 0) atOne++;
      if (rank >= 0 && rank < 3) atThree++;
      if (rank >= 0) reciprocal += 1 / (rank + 1);

      if (rank === 0 && q.expect_contains) {
        if (results[0].matching_content.includes(q.expect_contains)) contentOk++;
        else misses.push(`  ~ "${q.query}" — right neuron, wrong fact returned`);
      }

      if (rank !== 0) {
        const got = results[0] ? results[0].neuron_id : '(nothing)';
        misses.push(`  ✗ "${q.query}" — expected ${q.expect_neuron}, got ${got}` +
                    (rank > 0 ? ` (it was #${rank + 1})` : ''));
      }
    }

    const n = queries.length;
    const pct = (x) => `${((x / n) * 100).toFixed(1)}%`;

    console.log('');
    console.log('  📊 CRBRO retrieval eval');
    console.log('  ───────────────────────');
    console.log(`  Queries:          ${n}`);
    console.log(`  Right first hit:  ${atOne}/${n}  (${pct(atOne)})`);
    console.log(`  In the top 3:     ${atThree}/${n}  (${pct(atThree)})`);
    console.log(`  MRR:              ${(reciprocal / n).toFixed(3)}`);
    if (queries.some(q => q.expect_contains)) {
      const withContent = queries.filter(q => q.expect_contains).length;
      console.log(`  Right fact shown: ${contentOk}/${withContent}`);
    }

    if (misses.length > 0) {
      console.log('');
      console.log('  Misses:');
      for (const m of misses.slice(0, 25)) console.log(m);
      if (misses.length > 25) console.log(`  ... and ${misses.length - 25} more`);
    }
    console.log('');
  }).catch(console.error);

} else if (command === 'install-hooks') {
  // ─── Wire the SubagentStart hook into Claude Code ──────────────
  //
  // SessionStart context never reaches Task-spawned subagents, so without
  // this every subagent runs without the behavioral protocols the session
  // was booted with. This registers hooks/crbro-subagent.mjs, which reads
  // the same protocol neurons crbro_boot reads — one source of truth.
  //
  // Merges into ~/.claude/settings.json without touching anything else.
  // Idempotent: running it twice changes nothing the second time.
  import('fs').then(async fs => {
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    const here = dirname(fileURLToPath(import.meta.url));
    const source = join(here, '..', 'hooks', 'crbro-subagent.mjs');

    // Copy the hook to a stable location. When CRBRO runs from the npx
    // cache, `here` changes with every release and the stale path would
    // break the hook silently on the next update.
    const hookDir = join(homedir(), '.claude', 'crbro-hooks');
    const hookScript = join(hookDir, 'crbro-subagent.mjs');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.copyFileSync(source, hookScript);
    // Injection is OPT-IN since 1.12 (pre-registered consequence of three
    // clean-control benchmark runs: no measured benefit in any model, harm
    // and fabricated compliance in small ones — see the benchmarks in the
    // card repo). `install-hooks` alone installs the machinery inert;
    // `install-hooks --inject` enables injection for every subagent.
    const conInyeccion = process.argv.includes('--inject');
    const hookCmd = (conInyeccion ? 'CRBRO_SUBAGENT_INJECT=full ' : '') + `node "${hookScript.split('\\').join('/')}"`;

    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^﻿/, ''));
    } catch (e) {
      if (fs.existsSync(settingsPath)) {
        console.error(`  ❌ ${settingsPath} exists but could not be parsed — not touching it.`);
        console.error(`     ${e.message}`);
        process.exit(1);
      }
    }

    settings.hooks = settings.hooks || {};
    const list = settings.hooks.SubagentStart = settings.hooks.SubagentStart || [];
    const yaEsta = JSON.stringify(list).includes('crbro-subagent');
    if (yaEsta) {
      console.log('  ✅ SubagentStart hook already installed. Script refreshed.');
      if (conInyeccion && !JSON.stringify(list).includes('CRBRO_SUBAGENT_INJECT')) {
        console.log('     ⚠️  The installed entry does NOT enable injection. To enable it,');
        console.log('     remove the SubagentStart entry from settings.json and re-run');
        console.log('     install-hooks --inject.');
      }
      return;
    }
    list.push({
      hooks: [{
        type: 'command',
        command: hookCmd,
        timeout: 5,
        statusMessage: 'Inyectando protocolos CRBRO en el subagente...',
      }],
    });

    const tmp = settingsPath + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
    fs.renameSync(tmp, settingsPath);
    console.log('  ✅ SubagentStart hook installed.');
    console.log(`     ${settingsPath}`);
    if (conInyeccion) {
      console.log('     Injection ENABLED: every Task-spawned subagent receives the');
      console.log('     protocol block. Scope it with CRBRO_SUBAGENT_MATCHER (regex on');
      console.log('     agent_type) if needed. Measured caveat: on small models the');
      console.log('     block bought no benchmarked benefit and induced fabricated');
      console.log('     compliance in some runs — see the benchmarks before scoping.');
    } else {
      console.log('     Injection is OPT-IN and currently OFF (the measured default:');
      console.log('     three clean benchmark runs found no benefit in any model and');
      console.log('     harm in small ones). Re-run with --inject to enable it.');
    }
  }).catch(console.error);

} else if (command === 'install-boot') {
  // ─── The step that made the memory look broken ─────────────────
  //
  // Installing the MCP server does not call it. Without something that runs
  // crbro_boot at the start of a conversation, the brain sits there and the
  // assistant answers from nothing — the memory looks installed and behaves
  // like it was never there. Every report of "CRBRO does not remember" so far
  // has been this, not a bug in the recall.
  //
  // So this wires the start itself, per client:
  //
  //   Claude Code  ~/.claude/settings.json — SessionStart runs a command whose
  //                stdout is added to the session, telling the model to call
  //                crbro_boot first. Claude Code has no way to invoke an MCP
  //                tool from a hook, so the instruction is the mechanism.
  //   Codex        ~/.codex/hooks.json — SessionStart can call an MCP tool
  //                directly (type "mcp_tool"), so it does, AND keeps the same
  //                printed instruction as a second layer: the hook can fire
  //                before the MCP server has finished starting, and then the
  //                direct call is simply lost.
  //
  // Only files that already exist are touched, and each one is merged, never
  // rewritten. Idempotent: a second run reports and changes nothing.
  import('fs').then(async fs => {
    const AVISO =
      'CRBRO: call mcp__crbro__crbro_boot as your FIRST tool action, before answering, ' +
      'unless this session already contains its result. Discover deferred CRBRO tools first if needed. ' +
      'Apply the protocol_enforcement block it returns for the rest of the session.';

    // printf on a shell, Write-Output on Windows PowerShell. One line, no
    // external file: a path stored in a hook goes stale on the next update.
    const cmdPosix = `printf '%s\\n' ${JSON.stringify(AVISO)}`;
    const cmdWin = `powershell -NoProfile -Command ${JSON.stringify('Write-Output ' + JSON.stringify(AVISO))}`;
    const MATCHER = 'startup|resume|clear|compact';

    const leerJson = (p) => {
      if (!fs.existsSync(p)) return null;
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
      } catch (e) {
        console.error(`  ❌ ${p} exists but could not be parsed — not touching it.`);
        console.error(`     ${e.message}`);
        process.exit(1);
      }
    };
    const escribirJson = (p, obj) => {
      const tmp = p + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, p);
    };

    let tocados = 0, yaEstaban = 0, ausentes = [];

    // — Claude Code —
    const claudePath = join(homedir(), '.claude', 'settings.json');
    const claude = leerJson(claudePath) ?? (fs.existsSync(join(homedir(), '.claude')) ? {} : null);
    if (claude === null) {
      ausentes.push('Claude Code (~/.claude not found)');
    } else {
      claude.hooks = claude.hooks || {};
      const list = claude.hooks.SessionStart = claude.hooks.SessionStart || [];
      // Any mention of crbro counts as "already wired". A hand-rolled hook
      // often points at a file — `cat ~/.claude/crbro-session-start.txt` — so
      // looking for crbro_boot alone misses it and installs a second entry
      // that boots the brain twice.
      if (/crbro/i.test(JSON.stringify(list))) {
        yaEstaban++;
        console.log('  ⚪ Claude Code: SessionStart already starts CRBRO. Left alone.');
      } else {
        list.push({
          matcher: MATCHER,
          hooks: [{ type: 'command', command: cmdPosix, shell: 'bash', timeout: 10, statusMessage: 'Loading CRBRO memory...' }],
        });
        escribirJson(claudePath, claude);
        tocados++;
        console.log(`  ✅ Claude Code: SessionStart hook added.\n     ${claudePath}`);
      }
    }

    // — Codex —
    const codexDir = join(homedir(), '.codex');
    const codexPath = join(codexDir, 'hooks.json');
    if (!fs.existsSync(codexDir)) {
      ausentes.push('Codex (~/.codex not found)');
    } else {
      const codex = leerJson(codexPath) ?? {};
      codex.hooks = codex.hooks || {};
      const list = codex.hooks.SessionStart = codex.hooks.SessionStart || [];
      // Any mention of crbro counts as "already wired". A hand-rolled hook
      // often points at a file — `cat ~/.claude/crbro-session-start.txt` — so
      // looking for crbro_boot alone misses it and installs a second entry
      // that boots the brain twice.
      if (/crbro/i.test(JSON.stringify(list))) {
        yaEstaban++;
        console.log('  ⚪ Codex: SessionStart already starts CRBRO. Left alone.');
      } else {
        list.push({
          matcher: MATCHER,
          hooks: [
            { type: 'mcp_tool', server: 'crbro', tool: 'crbro_boot', input: {}, timeout: 30, statusMessage: 'Loading CRBRO memory...' },
            { type: 'command', command: cmdPosix, commandWindows: cmdWin, timeout: 10, statusMessage: 'Checking CRBRO start...' },
          ],
        });
        escribirJson(codexPath, codex);
        tocados++;
        console.log(`  ✅ Codex: SessionStart hook added (MCP call + fallback).\n     ${codexPath}`);
      }
    }

    console.log('');
    if (!tocados && !yaEstaban) {
      console.log('  ⚠️  Neither ~/.claude nor ~/.codex was found, so nothing was wired.');
    }
    for (const a of ausentes) console.log(`  ⚪ Skipped ${a}`);
    console.log('');
    console.log('  Other tools (Cursor, Windsurf, Antigravity…) have no session hooks.');
    console.log('  Put this line in their always-on rules file (.cursorrules, .windsurfrules,');
    console.log('  User Rules) and it does the same job:');
    console.log('');
    console.log(`    ${AVISO}`);
    console.log('');
    if (tocados) console.log('  Restart the tool, then check a new conversation actually boots CRBRO.');
    console.log('');
  }).catch(console.error);

} else if (command === 'secret') {
  // ─── Credentials, from the terminal ────────────────────────────
  //
  // Until 2.3 the only way to store a credential was the crbro_secret MCP
  // tool, which means typing it into a conversation with a model. For a
  // module whose whole point is that a secret never touches the brain, that
  // was the wrong last mile. These subcommands close it: the value is read
  // from stdin, never from argv, so it stays out of the shell history and
  // out of the process table where `ps` and Task Manager can read it.
  const sub = args[1];
  const name = args[2];

  const readPiped = () => new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { data += d; });
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
    process.stdin.on('error', reject);
  });

  // Interactive read with the echo off. Raw mode hands us every keystroke,
  // so nothing is drawn and nothing survives in the terminal scrollback.
  const readHidden = (promptText) => new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { cleanup(); process.stderr.write('\n'); return resolve(value); }
        if (ch === '\u0003') { cleanup(); process.stderr.write('\n'); return reject(new Error('Cancelled — nothing was stored.')); }
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    process.stderr.write(promptText);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });

  const flagValue = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : '';
  };

  import('../dist/engine/keychain.js').then(async (kc) => {
    try {
      if (sub === 'status') {
        const { backend, reason } = kc.detectBackend();
        console.log('');
        console.log('  🔐 CRBRO keychain');
        console.log('  ─────────────────');
        console.log(`  Backend:  ${backend || '❌ none available'}`);
        if (reason) console.log(`  Reason:   ${reason}`);
        if (backend === 'windows-dpapi') {
          const dir = process.env['CRBRO_KEYS_DIR'] || join(homedir(), '.crbro-keys');
          console.log(`  Store:    ${join(dir, 'keys.dpapi')}`);
          console.log('            Sealed to this Windows account: copied to another');
          console.log('            machine or lifted from a backup, it is unreadable.');
        }
        console.log('');
        console.log('  The store lives outside the brain. No sync, no team space and no');
        console.log('  crbro_share can reach it — per machine, on purpose.');
        console.log('');
        return;
      }

      if (sub === 'list') {
        const secrets = kc.listSecrets();
        console.log('');
        if (secrets.length === 0) {
          console.log('  🔐 No credentials stored on this machine yet.');
          console.log('     Store one:  npx crbro-memory secret set MY_TOKEN');
          console.log('');
          return;
        }
        console.log(`  🔐 ${secrets.length} credential(s) — names only, values are never listed.`);
        console.log('  ──────────────────────────────────────────────────────────');
        for (const s of secrets) {
          console.log(`  ${s.name.padEnd(28)} ${s.updated}  ${s.description || ''}`.trimEnd());
        }
        console.log('');
        return;
      }

      if (!name) {
        console.error(`  ❌ Missing name. Usage: npx crbro-memory secret ${sub || '<set|get|list|remove|status>'} NAME`);
        process.exit(1);
      }

      if (sub === 'set') {
        const value = process.stdin.isTTY
          ? await readHidden(`  Value for ${name} (input hidden, Enter to finish): `)
          : await readPiped();
        if (!value) {
          console.error('  ❌ Empty value. Nothing was stored.');
          process.exit(1);
        }
        kc.setSecret(name, value, flagValue('--description'));
        console.log(`  ✅ ${name} sealed in the OS keychain. CRBRO keeps no copy.`);
        console.log('     Record only the NAME in the brain, never the value.');
        return;
      }

      if (sub === 'get') {
        const value = kc.getSecret(name);
        if (value === null) {
          console.error(`  ❌ ${name} not found on this machine.`);
          process.exit(1);
        }
        if (process.stdout.isTTY) {
          process.stderr.write('  ⚠️  Printing a credential to the screen. Pipe it instead to keep it out of the scrollback.\n');
        }
        process.stdout.write(value + '\n');
        return;
      }

      if (sub === 'remove') {
        if (!args.includes('--yes')) {
          console.error(`  ❌ This deletes ${name} from the keychain and cannot be undone.`);
          console.error(`     Re-run to confirm:  npx crbro-memory secret remove ${name} --yes`);
          process.exit(1);
        }
        const removed = kc.removeSecret(name);
        console.log(removed ? `  ✅ ${name} removed.` : `  ⚪ ${name} was not there. Nothing changed.`);
        return;
      }

      console.error('  Usage: npx crbro-memory secret <set|get|list|remove|status> [NAME]');
      process.exit(1);
    } catch (err) {
      console.error(`  ❌ ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }).catch((err) => {
    console.error(`  ❌ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });

} else if (command === '--help' || command === '-h') {
  // ─── Help ──────────────────────────────────────────────────────
  console.log('');
  console.log('  🧠 CRBRO — Persistent Neural Memory for AI');
  console.log('  ═══════════════════════════════════════════');
  console.log('');
  console.log('  Setup:');
  console.log('    npx crbro-memory init             Initialize brain + detect IDEs');
  console.log('    npx crbro-memory install-boot     Make the memory load itself in every conversation');
  console.log('    npx crbro-memory status           Show brain status');
  console.log('');
  console.log('  Auto-Mining:');
  console.log('    npx crbro-memory mine [dir]       One-shot mining of artifacts');
  console.log('    npx crbro-memory setup-miner      Install scheduled auto-miner');
  console.log('    npx crbro-memory miner-status     Check auto-miner status');
  console.log('    npx crbro-memory remove-miner     Remove auto-miner');
  console.log('');
  console.log('  Search:');
  console.log('    npx crbro-memory reindex          Rebuild the search index');
  console.log('    npx crbro-memory eval             Measure retrieval against .crbro/.eval/queries.json');
  console.log('');
  console.log('  Semantic layer (opt-in, ~500 MB on disk, measured in benchmarks/):');
  console.log('    npx crbro-memory semantic install Install transformers.js into ~/.crbro/.semantic');
  console.log('    npx crbro-memory semantic build   Embed the whole brain once (needs CRBRO_SEMANTIC=1)');
  console.log('    npx crbro-memory semantic status  Runtime, model and whether it is enabled');
  console.log('');
  console.log('  Credentials (per machine, sealed in the OS keychain):');
  console.log('    npx crbro-memory secret set NAME     Store one; the value is read from stdin, never argv');
  console.log('    npx crbro-memory secret list         Names only, never values');
  console.log('    npx crbro-memory secret get NAME     Print one; pipe it to keep it off the screen');
  console.log('    npx crbro-memory secret remove NAME --yes');
  console.log('    npx crbro-memory secret status       Which keychain this machine offers');
  console.log('');
  console.log('  Server:');
  console.log('    npx crbro-memory                  Start MCP server (stdio)');
  console.log('');
  console.log('  Open source (MIT) — https://github.com/Octonove/crbro-memory');
  console.log('');

} else {
  // ─── Default: start MCP server ─────────────────────────────────
  import('../dist/index.js').catch(console.error);
}
