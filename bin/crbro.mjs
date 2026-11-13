#!/usr/bin/env node

// ─── CRBRO CLI ───────────────────────────────────────────────────
// Command-line interface for CRBRO memory system
// Supports: init, status, secret, mine, setup-miner, miner-status, usage, postmortem,
//           remove-miner, install-hooks, install-mod, and MCP server mode (default)

import { platform, homedir } from 'os';
import { join, dirname, basename } from 'path';
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

// The Claude Code SessionStart command install-boot writes. Kept in one place
// because `install-hooks --compact` has to recognise it to replace it.
function bootCommandPosix(aviso) {
  return `printf '%s\\n' ${JSON.stringify(aviso)}`;
}

/** An install-boot entry, this release's or an older one with other wording. */
function isInstallBootHook(h) {
  return !!h && typeof h.command === 'string' && h.command.startsWith("printf '%s\\n' ") && h.command.includes('crbro_boot');
}

const args = process.argv.slice(2);
const command = args[0];

// ─── Commands ────────────────────────────────────────────────────
//
// Every command the CLI knows, one entry each. Before anything runs, the
// arguments are checked against its entry: an unknown command or flag is
// rejected with a short help and exit code 2 (it used to start the MCP
// server, or — `install-hooks --help` — install), `<command> --help` prints
// the entry and runs nothing, `--version` prints the version.
//
//   usage    the synopsis, as printed by --help and in errors
//   about    one or more lines of description
//   flags    switches it accepts; values: flags that take a value (--x v or --x=v)
//   args     how many positional arguments it takes (default 0)
//   free     its own parser checks the arguments (daemon, guard, backup)
//   run      async (args) => void, for commands dispatched from this table;
//            the older ones are dispatched by the if/else chain further down.
//
// To add a command: one entry here, with `run` importing its module, e.g.
//   view: { usage: 'view [--port N]', about: ['Local viewer'], values: ['--port'], run: a => import(<its module in dist>).then(m => m.main(a)) },
// A command that fails sets process.exitCode = 1 (or throws: fail() below does it).
const COMMANDS = {
  install: { usage: 'install [--clients auto|claude-code,claude-desktop,codex,cursor] [--dry-run] [--engine-dir DIR] [--json]',
    about: ['Install CRBRO for every MCP client found: copies this engine to ~/.crbro-engine (no npx at startup),',
      'registers it in each client (Codex with timeouts), and wires the session start. Prints what it did.'],
    flags: ['--dry-run', '--json'], values: ['--clients', '--engine-dir'] },
  uninstall: { usage: 'uninstall [--clients auto|claude-code,claude-desktop,codex,cursor] [--dry-run] [--engine-dir DIR] [--json]',
    about: ['Remove what CRBRO added: registrations that run it, its hooks and boot wiring, the mod, the engine folder.',
      'Backups are kept and the brain (~/.crbro) is never touched.'],
    flags: ['--dry-run', '--json'], values: ['--clients', '--engine-dir'] },
  init: { usage: 'init [--no-semantic]', about: ['Initialize the brain, detect clients, install semantic recall (skip with --no-semantic)'], flags: ['--no-semantic'] },
  'install-boot': { usage: 'install-boot [--dry-run]', about: ['Make the memory load itself at the start of every conversation (Claude Code, Codex)'], flags: ['--dry-run'] },
  status: { usage: 'status', about: ['Show brain status'] },
  doctor: { usage: 'doctor [--json]', about: ['Read-only local diagnostics: brain, clients, hooks, daemon leftovers, backups. Never initializes or boots'], flags: ['--json'] },
  activate: { usage: 'activate', about: ['Legacy (pre-1.4.0): CRBRO is free, nothing to activate'] },
  mine: { usage: 'mine [dir]', about: ['One-shot mining of editor artifacts'], args: 1 },
  'setup-miner': { usage: 'setup-miner', about: ['Install the scheduled auto-miner'] },
  'miner-status': { usage: 'miner-status', about: ['Check auto-miner status'] },
  'remove-miner': { usage: 'remove-miner', about: ['Remove the auto-miner'] },
  reindex: { usage: 'reindex', about: ['Rebuild the search index'] },
  semantic: { usage: 'semantic [status|install|build]', about: ['Semantic recall (installed by init): status, install the runtime, embed the whole brain'], args: 1, choices: ['status', 'install', 'build'] },
  eval: { usage: 'eval', about: ['Measure retrieval against <brain>/.eval/queries.json'] },
  daemon: { usage: 'daemon [status|on|off|stop]', about: ['One process owns the brain for every client (opt-in)'], free: true },
  guard: { usage: 'guard "<command line>" | guard --rebuild', about: ['What the PreToolUse guard would say for a command; --rebuild writes the trigger index'], free: true },
  usage: { usage: 'usage [--days N] [--session ID] [--project DIR] [--json]', about: ['Tokens per model and session from Claude Code logs (read-only)'], flags: ['--json'], values: ['--days', '--session', '--project'] },
  postmortem: { usage: 'postmortem [--days N] [--session ID] [--project DIR] [--max N] [--json]', about: ['Candidate lessons from Claude Code logs (read-only)'], flags: ['--json'], values: ['--days', '--session', '--project', '--max'] },
  'install-hooks': { usage: 'install-hooks [--inject] | --guard | --compact | --verify [--json]',
    about: ['Claude Code hooks: SubagentStart (alone; --inject enables injection), the PreToolUse guard (--guard),',
      'compaction checkpoints (--compact), or check the installed copies against this package (--verify)'],
    flags: ['--inject', '--guard', '--compact', '--verify', '--json'] },
  'uninstall-hooks': { usage: 'uninstall-hooks --compact', about: ['Remove the compaction hooks and put back what they replaced'], flags: ['--compact'] },
  'install-mod': { usage: 'install-mod [--lang en|es|auto] | install-mod --verify [--json]', about: ['Claude Code band + /pending with the open items'], flags: ['--verify', '--json'], values: ['--lang'] },
  'uninstall-mod': { usage: 'uninstall-mod', about: ['Remove the mod and its CLAUDE_CODE_PLUGIN_DIRS entry; never put back on its own'] },
  secret: { usage: 'secret <set|get|list|remove|status> [NAME] [--description TEXT] [--yes]', about: ['Credentials, sealed in the OS keychain'], args: 2, flags: ['--yes'], values: ['--description'] },
  backup: { usage: 'backup [list | restore FILE [--into DIR]] [--dir DIR] [--keep N]', about: ['Back the brain up now, list the copies, or restore one into a NEW folder'], free: true },
  help: { usage: 'help [command]', about: ['This help, or one command\'s'], args: 1 },
};
/** Arguments that start the MCP server, as no arguments do. */
const SERVER_FLAGS = new Set(['--daemon', '--proxy', '--stdio']);

function commandHelp(name) {
  const c = COMMANDS[name];
  const lines = ['', `  npx crbro-memory ${c.usage}`, ''];
  for (const l of c.about) lines.push(`  ${l}`);
  lines.push('');
  return lines.join('\n');
}

function shortHelp() {
  return `  Commands: ${Object.keys(COMMANDS).join(', ')}\n  npx crbro-memory --help for all of them, npx crbro-memory <command> --help for one.`;
}

/** Exit code 2: the command line itself is wrong. Nothing ran. */
function usageError(message) {
  console.error(`  ❌ ${message}`);
  console.error(shortHelp());
  process.exit(2);
}

/** A command that failed: a short message (never a stack trace) and exit code 1. */
function fail(err) {
  const msg = err && err.code === 'ERR_MODULE_NOT_FOUND' ? 'Build required. Run: npm run build'
    : err instanceof Error ? err.message : String(err);
  console.error(`  ❌ ${msg}`);
  process.exitCode = 1;
}

/** Checks the arguments against the command's entry; exits 2 on anything it does not take. */
function checkArgs(name, rest) {
  const c = COMMANDS[name];
  if (c.free) return;
  const flags = new Set(c.flags || []);
  const values = new Set(c.values || []);
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('-')) {
      const [flag, inline] = a.split(/=(.*)/s);
      if (values.has(flag)) {
        if (inline === undefined) {
          if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) usageError(`${flag} needs a value. Usage: npx crbro-memory ${c.usage}`);
          i++;
        }
      } else if (!flags.has(flag) || inline !== undefined) {
        usageError(`unknown option for ${name}: ${a}. Usage: npx crbro-memory ${c.usage}`);
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > (c.args || 0)) usageError(`unexpected argument for ${name}: ${positional[c.args || 0]}. Usage: npx crbro-memory ${c.usage}`);
  if (c.choices && positional[0] !== undefined && !c.choices.includes(positional[0])) {
    usageError(`${name} takes ${c.choices.join(', ')}; got: ${positional[0]}`);
  }
}

/**
 * Runs before the if/else chain. True when it handled the command line
 * (version, help, an error, or a command with `run`); false to go on.
 */
function preDispatch() {
  if (command === undefined || SERVER_FLAGS.has(command)) return false;      // the MCP server
  if (command === '--version' || command === '-v' || command === 'version') { console.log(pkgVersion()); return true; }
  if (command === '--help' || command === '-h' || command === 'help') {
    const topic = args[1];
    if (topic && !topic.startsWith('-')) {
      if (!COMMANDS[topic]) usageError(`unknown command: ${topic}`);
      console.log(commandHelp(topic));
    } else printHelp();
    return true;
  }
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, command)) {
    usageError(command.startsWith('-') ? `unknown option: ${command}` : `unknown command: ${command}`);
  }
  // `<command> --help` explains and runs nothing — install-hooks --help used to install.
  if (args.slice(1).some(a => a === '--help' || a === '-h')) { console.log(commandHelp(command)); return true; }
  checkArgs(command, args.slice(1));
  const run = COMMANDS[command].run;
  if (run) {
    Promise.resolve().then(() => run(args.slice(1))).catch(fail);
    return true;
  }
  return false;
}

/** What install, uninstall and install-boot need: the installer modules and the context they run in. */
async function installContext(extra = {}) {
  const [inst, io, { BOOT_NOTICE }] = await Promise.all([
    import('../dist/engine/installer.js'), import('../dist/engine/installio.js'), import('../hooks/crbro-lifecycle.mjs'),
  ]);
  const here = dirname(fileURLToPath(import.meta.url));
  const ctx = {
    home: homedir(), env: process.env, platform: platform(), dryRun: false,
    packageRoot: join(here, '..'), nodePath: process.execPath, bootNotice: BOOT_NOTICE,
    claude: inst.claudeCli(process.env, platform()), ...extra,
  };
  return { ctx, inst, io };
}

/** The value of a flag given as `--x v` or `--x=v`; undefined when absent. */
function flagValue(name) {
  for (let i = 1; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(name + '=')) return args[i].slice(name.length + 1);
  }
  return undefined;
}

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

if (preDispatch()) {
  // Handled before the chain: --version, --help, an error, or a command with `run`.
} else if (command === 'doctor') {
  // Observational only: never fall through to initialization or MCP startup.
  const json = args.includes('--json');
  try {
    if (args.slice(1).some(arg => arg !== '--json')) throw new Error('invalid doctor option');
    const { diagnose, formatDoctor } = await import('../dist/engine/doctor.js');
    const report = await diagnose({ env: process.env, cwd: process.cwd() });
    console.log(json ? JSON.stringify(report, null, 2) : formatDoctor(report));
    process.exitCode = report.status === 'error' ? 1 : 0;
  } catch {
    // Do not print exception text: configuration/JSON errors can quote secrets.
    const failure = { schema_version: 1, read_only: true, status: 'error', error: 'doctor_unavailable_or_invalid_options' };
    console.log(json ? JSON.stringify(failure) : 'CRBRO doctor: unavailable or invalid options; use doctor [--json].');
    process.exitCode = 1;
  }

} else if (command === 'init') {
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
  }).catch(fail);

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
      process.exitCode = 1;
    }
  }).catch(fail);

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
      process.exitCode = 1;
    }

    console.log('');
  }).catch(fail);

} else if (command === 'setup-miner') {
  // ─── Setup automatic mining ────────────────────────────────────
  import('../dist/miner/scheduler.js').then(async ({ setupScheduler }) => {
    console.log('');
    console.log('  ⏰ Setting up CRBRO Auto-Miner...');
    console.log('');

    const result = await setupScheduler();
    console.log(result.message);
    if (!result.success) process.exitCode = 1;
    console.log('');
  }).catch(fail);

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
  }).catch(fail);

} else if (command === 'remove-miner') {
  // ─── Remove automatic mining ───────────────────────────────────
  import('../dist/miner/scheduler.js').then(async ({ removeScheduler }) => {
    const result = await removeScheduler();
    console.log('');
    console.log(result.success ? `  ✅ ${result.message}` : `  ❌ ${result.message}`);
    if (!result.success) process.exitCode = 1;
    console.log('');
  }).catch(fail);

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
  }).catch(fail);

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
        process.exitCode = 1;
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
  }).catch(fail);

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
      process.exitCode = 1;
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
  }).catch(fail);

} else if (command === 'daemon') {
  // ─── One process owns the brain for every client (opt-in) ──────
  //
  //   crbro daemon status     is it on, who is running, how much it holds
  //   crbro daemon on         every client of this brain becomes a thin proxy
  //   crbro daemon off        back to one full server per client, and stop what runs
  //   crbro daemon stop       stop the running daemon(s); clients start a new one on demand
  //
  // The switch is a flag inside the brain, so every client flips together the
  // next time it starts. Nothing is lost by turning it off, or by the daemon
  // dying: a client that cannot reach one serves itself, as before 2.5.
  (async () => {
    const { resolveBrainDir } = await import('../dist/engine/brain.js');
    const ep = await import('../dist/daemon/endpoint.js');
    const { controlDaemon } = await import('../dist/daemon/proxy.js');
    const fs = await import('fs');
    const root = resolveBrainDir();
    const sub = args[1] || 'status';

    const running = async () => {
      const out = [];
      for (const st of await ep.listStates(root)) {
        const reply = await controlDaemon(root, 'status', st.build);
        if (reply) { out.push({ st, reply }); continue; }
        // No answer is not proof of death: a daemon in the middle of a rebuild
        // answers late, and deleting its state file would orphan it — alive,
        // holding the brain, and unreachable by every client. Only a pid the
        // system says is gone loses its file.
        let alive = true;
        try { process.kill(st.pid, 0); } catch (e) { alive = e.code === 'EPERM'; }
        if (alive) out.push({ st, reply: null });
        else { try { fs.rmSync(ep.stateFile(root, st.build), { force: true }); } catch { /* stale file, best effort */ } }
      }
      return out;
    };

    if (sub === 'on' || sub === 'off') {
      await ep.setDaemonEnabled(root, sub === 'on');
      console.log('');
      if (sub === 'on') {
        console.log('  ✅ Daemon mode ON for ' + root);
        console.log('     Restart your MCP clients (Claude Code, Claude Desktop, Codex...). The first one to start');
        console.log('     launches the daemon; the rest attach to it. One index, one model, one writer.');
        console.log('     Clients older than 2.5 keep running their own server — update them to get the benefit.');
      } else {
        for (const { st, reply } of await running()) if (reply) await controlDaemon(root, 'stop', st.build);
        console.log('  ✅ Daemon mode OFF. Clients go back to one full server each the next time they start.');
      }
      console.log('');
    } else if (sub === 'stop') {
      const list = await running();
      for (const { st, reply } of list) if (reply) await controlDaemon(root, 'stop', st.build);
      console.log(list.length ? `\n  ✅ Asked ${list.length} daemon(s) to stop. Connected clients carry on: they start a new one on their next call.\n`
                              : '\n  No daemon is running for this brain.\n');
    } else {
      const list = await running();
      console.log('');
      console.log('  🧠 CRBRO daemon');
      console.log('  ───────────────');
      console.log(`  Brain:    ${root}`);
      console.log(`  Mode:     ${ep.daemonEnabled(root) ? '✅ on' : 'off  (npx crbro-memory daemon on)'}`);
      if (list.length === 0) console.log('  Running:  none' + (ep.daemonEnabled(root) ? ' — the next client to start launches it' : ''));
      for (const { st, reply } of list) {
        if (!reply) { console.log(`  Running:  pid ${st.pid} · ${st.version} (${st.build}) · alive but not answering right now (busy, or another user's)`); continue; }
        console.log(`  Running:  pid ${reply.pid} · ${reply.version} (${reply.build}) · ${reply.connections} conversation(s) · ${reply.rss_mb} MB · up ${Math.round(reply.uptime_s / 60)} min · idle exit ${reply.idle_minutes} min`);
      }
      if (list.length > 1) console.log('  ⚠️  More than one build is serving this brain. Point every client at the same install to share one.');
      console.log(`  Log:      ${root}${root.includes('\\') ? '\\' : '/'}.daemon${root.includes('\\') ? '\\' : '/'}daemon.log`);
      console.log('');
    }
  })().catch(e => { console.error(e.message); process.exit(1); });

} else if (command === 'guard') {
  // ─── What the PreToolUse guard would say for a command ─────────
  //
  //   crbro guard "firebase deploy --only hosting"
  //   crbro guard --rebuild        write the trigger index now
  //
  // Reads <brain>/.search/triggers.json, the lookup crbro_consolidate
  // derives from the error, debt and pattern ledgers. Read-only unless
  // --rebuild is passed.
  (async () => {
    const { Brain } = await import('../dist/engine/brain.js');
    const { writeTriggerIndex, triggerIndexPath, lessonsFor } = await import('../dist/engine/triggers.js');
    const fs = await import('fs');
    const brain = new Brain();
    if (process.argv.includes('--rebuild')) {
      const r = await writeTriggerIndex(brain);
      if ('error' in r) { console.error(`  ❌ ${r.error}`); process.exit(1); }
      console.log(`  ✅ Trigger index written: ${r.entries} lessons under ${r.keys} commands.`);
      console.log(`     ${triggerIndexPath(brain)}`);
    }
    const texto = process.argv.slice(3).filter(a => !a.startsWith('--')).join(' ').trim();
    if (!texto) {
      if (!process.argv.includes('--rebuild')) console.log('  Usage: npx crbro-memory guard "<command line>"   |   npx crbro-memory guard --rebuild');
      return;
    }
    let index;
    try {
      index = JSON.parse(fs.readFileSync(triggerIndexPath(brain), 'utf8'));
    } catch {
      console.log('  No trigger index yet. Run: npx crbro-memory guard --rebuild (crbro_consolidate writes it too).');
      process.exitCode = 1;
      return;
    }
    const lessons = lessonsFor(index, texto, 10);
    if (lessons.length === 0) { console.log('  Nothing stored mentions that command.'); return; }
    for (const l of lessons) console.log(`  • [${l.k}${l.d ? ' · ' + l.d : ''} · ${l.n}] ${l.t}\n`);
  })().catch(e => { console.error(e.message); process.exit(1); });

} else if (command === 'usage' || command === 'postmortem') {
  // ─── Token spend and post-mortem, from Claude Code's own logs ──
  //
  //   crbro usage      [--days N] [--session <id>] [--project <folder>] [--json]
  //   crbro postmortem [--days N] [--session <id>] [--project <folder>] [--max N] [--json]
  //
  // Both read ~/.claude/projects/<project>/<session>.jsonl (and, for usage,
  // the subagent logs under <session>/subagents/) through one streaming
  // reader. usage reads message.model and message.usage only; postmortem
  // reads what the person typed and tool names, never a tool's input or
  // result, and redacts everything it prints. Neither writes anything.
  const flag = (name) => { const i = args.indexOf(name); return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined; };
  const intFlag = (name) => {
    const v = flag(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) { console.error(`  ❌ ${name} expects a whole number ≥ 0; got: ${v}`); process.exit(1); }
    return n;
  };
  const session = flag('--session');
  const project = flag('--project');
  // Last 7 days unless told otherwise (--days 0 = all); a named session is looked for everywhere.
  const daysArg = intFlag('--days');
  const days = daysArg !== undefined ? (daysArg === 0 ? undefined : daysArg) : (session ? undefined : 7);
  const max = intFlag('--max');
  const json = args.includes('--json');
  const mod = command === 'usage' ? '../dist/engine/usage.js' : '../dist/engine/postmortem.js';
  import(mod).then(async m => {
    if (command === 'usage') {
      const r = await m.collectUsage({ days, session, project });
      console.log(json ? JSON.stringify(r, null, 2) : m.formatUsage(r));
    } else {
      const r = await m.runPostmortem({ days, session, project, max });
      console.log(json ? JSON.stringify(r, null, 2) : m.formatPostmortem(r));
    }
  }).catch(err => {
    console.error('  ❌ ' + (err && err.code === 'ERR_MODULE_NOT_FOUND' ? 'Build required. Run: npm run build' : err.message));
    process.exit(1);
  });

} else if (command === 'install-hooks' && process.argv.includes('--verify')) {
  // ─── Are the installed hooks the ones this package ships? ──────
  // SHA-256 of each copy in ~/.claude/crbro-hooks/ against hooks/ here, and
  // whether every CRBRO hook settings.json runs exists. Read-only. Exit 1 on
  // any difference, so it can gate a script.
  // The Claude Code mod is checked too (install-mod): a copy in the home
  // folder that runs in every session, so the same question applies.
  // Codex's copy (<CODEX_HOME>/crbro-hooks, run by hooks.json) is checked the same way when it exists.
  Promise.all([import('../dist/engine/hookverify.js'), import('../dist/engine/modinstall.js'), import('../dist/engine/installio.js')]).then(([
    { verifyHooks, formatVerify },
    { verifyMod, formatModVerify },
    io,
  ]) => {
    const here = dirname(fileURLToPath(import.meta.url));
    const claudeHome = io.claudeDir(homedir(), process.env);
    const r = verifyHooks({
      packageDir: join(here, '..', 'hooks'),
      installedDir: join(claudeHome, 'crbro-hooks'),
      settingsPath: join(claudeHome, 'settings.json'),
    });
    const codexHome = io.codexHome(homedir(), process.env);
    const codex = existsSync(join(codexHome, 'crbro-hooks')) ? verifyHooks({
      packageDir: join(here, '..', 'hooks'),
      installedDir: join(codexHome, 'crbro-hooks'),
      settingsPath: join(codexHome, 'hooks.json'),
    }) : null;
    const m = verifyMod({ packageDir: join(here, '..', 'mods', 'crbro-pending'), home: homedir() });
    if (args.includes('--json')) console.log(JSON.stringify({ ...r, mod: m, ...(codex ? { codex } : {}) }, null, 2));
    else console.log(formatVerify(r) + (codex ? formatVerify(codex) : '') + formatModVerify(m));
    if (!r.ok || !m.ok || (codex && !codex.ok)) process.exitCode = 1;
  }).catch(err => {
    console.error('  ❌ ' + (err && err.code === 'ERR_MODULE_NOT_FOUND' ? 'Build required. Run: npm run build' : err.message));
    process.exit(1);
  });

} else if ((command === 'install-hooks' || command === 'uninstall-hooks') && process.argv.includes('--compact')) {
  // ─── Compact without losing the thread (opt-in, Claude Code only) ──
  //
  // PreCompact → hooks/crbro-lifecycle.mjs pre-compact: a mechanical,
  //   redacted checkpoint of the session in <brain>/checkpoints/, plus the
  //   "keep what is not saved yet" reminder.
  // SessionStart → hooks/crbro-lifecycle.mjs session-start: the boot notice,
  //   the folder and its git remote, and after a compaction what was being
  //   done before it.
  //
  // Only Claude Code has PreCompact, so ~/.codex is never touched. The entry
  // install-boot wrote for Claude Code prints the very notice session-start
  // prints, so it is replaced, and the replaced hook is kept aside in
  // crbro-hooks/ so uninstall puts it back exactly. A hand-written CRBRO hook
  // is never replaced: ours is installed with --no-boot / --no-reminder next
  // to it, so nothing is read twice. Merged, never rewritten; idempotent.
  Promise.all([import('fs'), import('../dist/engine/installio.js'), import('../dist/engine/hookrefresh.js')]).then(async ([fs, io, hr]) => {
    const claudeHome = io.claudeDir(homedir(), process.env);
    const settingsPath = join(claudeHome, 'settings.json');
    const hookDir = join(claudeHome, 'crbro-hooks');
    const hookScript = join(hookDir, 'crbro-lifecycle.mjs');
    const replacedPath = join(hookDir, 'crbro-lifecycle.replaced.json');
    const ours = h => !!h && typeof h.command === 'string' && h.command.includes('crbro-lifecycle');
    const entryIsOurs = e => Array.isArray(e?.hooks) && e.hooks.some(ours);

    // A settings.json that is not a JSON object is never touched.
    const read = io.readJsonObject(settingsPath);
    if (!read.ok) { console.error(`  ❌ ${read.error}`); process.exit(1); }
    let settings = read.value;
    if (settings?.hooks !== undefined && (typeof settings.hooks !== 'object' || settings.hooks === null || Array.isArray(settings.hooks))) {
      console.error(`  ❌ hooks in ${settingsPath} is not an object — not touching it.`);
      process.exit(1);
    }
    for (const event of ['PreCompact', 'SessionStart']) {
      const v = settings?.hooks?.[event];
      if (v !== undefined && !Array.isArray(v)) {
        console.error(`  ❌ hooks.${event} in ${settingsPath} is not a list — not touching it.`);
        process.exit(1);
      }
    }
    // A backup first; refused if Claude Code or an editor saved it since it was read.
    const write = obj => {
      const backup = io.writeGuarded(settingsPath, io.jsonText(obj, read.indent, read.eol, read.bom), { expectHash: read.hash });
      if (backup) console.log(`     backup: ${backup}`);
    };

    if (command === 'uninstall-hooks') {
      if (!settings || !settings.hooks) {
        console.log('  ⚪ No Claude Code settings with hooks: nothing to remove.');
      } else {
        let removed = 0;
        for (const event of ['PreCompact', 'SessionStart']) {
          const list = settings.hooks[event];
          if (!Array.isArray(list)) continue;
          const kept = [];
          for (const entry of list) {
            if (!entryIsOurs(entry)) { kept.push(entry); continue; }
            const rest = entry.hooks.filter(h => !ours(h));
            removed += entry.hooks.length - rest.length;
            if (rest.length) kept.push({ ...entry, hooks: rest });
          }
          if (kept.length) settings.hooks[event] = kept; else delete settings.hooks[event];
        }
        // Put back what install replaced, unless an equal hook is already there.
        let restored = 0;
        try {
          const rec = JSON.parse(fs.readFileSync(replacedPath, 'utf8'));
          for (const { matcher, hook } of Array.isArray(rec.SessionStart) ? rec.SessionStart : []) {
            const list = settings.hooks.SessionStart = settings.hooks.SessionStart || [];
            if (JSON.stringify(list).includes(JSON.stringify(hook.command))) continue;
            list.push(matcher !== undefined ? { matcher, hooks: [hook] } : { hooks: [hook] });
            restored++;
          }
        } catch { /* nothing was replaced */ }
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
        if (removed || restored) {
          write(settings);
          console.log(`  ✅ Compact hooks removed (${removed}).${restored ? ` The install-boot SessionStart entry is back (${restored}).` : ''}`);
          console.log(`     ${settingsPath}`);
        } else {
          console.log('  ⚪ Compact hooks were not installed. Nothing changed.');
        }
      }
      for (const f of [hookScript, replacedPath]) { try { fs.unlinkSync(f); } catch { /* not there */ } }
      console.log('     Checkpoints already written stay in <brain>/checkpoints/ and expire after 7 days.');
      return;
    }

    // — install —
    if (settings === null && !fs.existsSync(claudeHome)) {
      console.log(`  ⚪ ${claudeHome} not found: Claude Code is the only client with PreCompact, so nothing was wired.`);
      return;
    }
    const here = dirname(fileURLToPath(import.meta.url));
    // Copied with a manifest entry, so later releases refresh it on their own while it is unmodified.
    const source = join(here, '..', 'hooks', 'crbro-lifecycle.mjs');
    hr.installHookFile(dirname(source), basename(source), hookDir);
    settings = settings || {};
    settings.hooks = settings.hooks || {};
    const node = `node "${hookScript.split('\\').join('/')}"`;
    let changed = false;

    // SessionStart
    const start = settings.hooks.SessionStart = settings.hooks.SessionStart || [];
    if (start.some(entryIsOurs)) {
      console.log('  ✅ SessionStart: already installed. Script refreshed.');
    } else {
      const replaced = [];
      for (let i = start.length - 1; i >= 0; i--) {
        const entry = start[i];
        if (!Array.isArray(entry?.hooks) || !entry.hooks.some(isInstallBootHook)) continue;
        for (const h of entry.hooks.filter(isInstallBootHook)) replaced.unshift({ matcher: entry.matcher, hook: h });
        const rest = entry.hooks.filter(h => !isInstallBootHook(h));
        if (rest.length) start[i] = { ...entry, hooks: rest }; else start.splice(i, 1);
      }
      // A hand-written CRBRO start (cat ~/.claude/crbro-session-start.txt…)
      // stays, and ours stops printing the notice it already prints.
      const handWritten = /crbro/i.test(JSON.stringify(start));
      start.push({
        matcher: 'startup|resume|clear|compact',
        hooks: [{ type: 'command', command: `${node} session-start${handWritten ? ' --no-boot' : ''}`, timeout: 10, statusMessage: 'Loading CRBRO memory...' }],
      });
      if (replaced.length) fs.writeFileSync(replacedPath, JSON.stringify({ SessionStart: replaced }, null, 2), 'utf8');
      changed = true;
      console.log(`  ✅ SessionStart: lifecycle hook added${replaced.length ? ', replacing the install-boot entry (same notice, plus the project line)' : ''}${handWritten ? '; your own CRBRO start hook is kept and the notice is not repeated' : ''}.`);
    }

    // PreCompact
    const pre = settings.hooks.PreCompact = settings.hooks.PreCompact || [];
    if (pre.some(entryIsOurs)) {
      console.log('  ✅ PreCompact: already installed. Script refreshed.');
    } else {
      const handWritten = /crbro/i.test(JSON.stringify(pre));
      pre.push({
        hooks: [{ type: 'command', command: `${node} pre-compact${handWritten ? ' --no-reminder' : ''}`, timeout: 10, statusMessage: 'Saving a CRBRO checkpoint...' }],
      });
      changed = true;
      console.log(`  ✅ PreCompact: checkpoint hook added${handWritten ? '; your own CRBRO reminder is kept and not repeated' : ''}.`);
    }

    if (changed) {
      write(settings);
      console.log(`     ${settingsPath}`);
      console.log('     Undo with: npx crbro-memory uninstall-hooks --compact');
    }
    console.log('     Never blocks; checkpoints are redacted and expire after 7 days. New sessions pick it up.');
  }).catch(fail);

} else if (command === 'uninstall-hooks') {
  console.log('  Usage: npx crbro-memory uninstall-hooks --compact');
  console.log('  (the guard and subagent hooks are removed by deleting their entry from settings.json, or all of CRBRO with: npx crbro-memory uninstall)');
  process.exitCode = 2;

} else if (command === 'install-hooks' && process.argv.includes('--guard')) {
  // ─── Wire the PreToolUse guard into Claude Code (opt-in) ───────
  //
  // Before a Bash or PowerShell call, hooks/crbro-guard.mjs looks the command
  // up in the trigger index and adds the stored errors, debts and patterns
  // that mention it to the model's context — once per session each, three at
  // most. It never blocks and never asks. Remove the PreToolUse entry from
  // ~/.claude/settings.json to uninstall.
  Promise.all([import('../dist/engine/installio.js'), import('../dist/engine/hookrefresh.js')]).then(async ([io, hr]) => {
    const claudeHome = io.claudeDir(homedir(), process.env);
    const settingsPath = join(claudeHome, 'settings.json');
    const here = dirname(fileURLToPath(import.meta.url));
    const hookDir = join(claudeHome, 'crbro-hooks');
    const source = join(here, '..', 'hooks', 'crbro-guard.mjs');
    const hookScript = hr.installHookFile(dirname(source), basename(source), hookDir);

    let installed = false;
    const r0 = io.updateJsonFile(settingsPath, settings => {
      if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || settings.hooks === null || Array.isArray(settings.hooks))) throw new Error(`hooks in ${settingsPath} is not an object — not touching it.`);
      settings.hooks = settings.hooks || {};
      if (settings.hooks.PreToolUse !== undefined && !Array.isArray(settings.hooks.PreToolUse)) throw new Error(`hooks.PreToolUse in ${settingsPath} is not a list — not touching it.`);
      const list = settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];
      if (JSON.stringify(list).includes('crbro-guard')) return false;
      list.push({
        matcher: 'Bash|PowerShell',
        hooks: [{ type: 'command', command: `node "${hookScript.split('\\').join('/')}"`, timeout: 5 }],
      });
      installed = true;
      return true;
    });
    if (!r0.ok) { console.error(`  ❌ ${r0.error}`); process.exit(1); }
    if (!installed) {
      console.log('  ✅ PreToolUse guard already installed. Script refreshed.');
    } else {
      console.log('  ✅ PreToolUse guard installed.');
      console.log(`     ${settingsPath}`);
      if (r0.backup) console.log(`     backup: ${r0.backup}`);
    }
    const { Brain } = await import('../dist/engine/brain.js');
    const { writeTriggerIndex } = await import('../dist/engine/triggers.js');
    const r = await writeTriggerIndex(new Brain());
    if ('error' in r) { console.log(`  ⚠️  Trigger index not written: ${r.error}`); process.exitCode = 1; }
    else console.log(`     Trigger index: ${r.entries} lessons under ${r.keys} commands. Try: npx crbro-memory guard "git push"`);
    console.log('     It adds context, never blocks. New sessions pick it up.');
  }).catch(fail);

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
  Promise.all([import('../dist/engine/installio.js'), import('../dist/engine/hookrefresh.js')]).then(async ([io, hr]) => {
    const claudeHome = io.claudeDir(homedir(), process.env);
    const settingsPath = join(claudeHome, 'settings.json');
    const here = dirname(fileURLToPath(import.meta.url));
    const source = join(here, '..', 'hooks', 'crbro-subagent.mjs');

    // Copy the hook to a stable location. When CRBRO runs from the npx
    // cache, `here` changes with every release and the stale path would
    // break the hook silently on the next update.
    // installHookFile records it in the folder's manifest: an unmodified copy
    // is refreshed on its own by later releases (hookrefresh.ts).
    const hookDir = join(claudeHome, 'crbro-hooks');
    const hookScript = hr.installHookFile(dirname(source), basename(source), hookDir);
    // Injection is OPT-IN since 1.12 (pre-registered consequence of three
    // clean-control benchmark runs: no measured benefit in any model, harm
    // and fabricated compliance in small ones — see the benchmarks in the
    // card repo). `install-hooks` alone installs the machinery inert;
    // `install-hooks --inject` enables injection for every subagent.
    const conInyeccion = process.argv.includes('--inject');
    const hookCmd = (conInyeccion ? 'CRBRO_SUBAGENT_INJECT=full ' : '') + `node "${hookScript.split('\\').join('/')}"`;

    let yaEsta = false, injectsAlready = false;
    const r0 = io.updateJsonFile(settingsPath, settings => {
      if (settings.hooks !== undefined && (typeof settings.hooks !== 'object' || settings.hooks === null || Array.isArray(settings.hooks))) throw new Error(`hooks in ${settingsPath} is not an object — not touching it.`);
      settings.hooks = settings.hooks || {};
      if (settings.hooks.SubagentStart !== undefined && !Array.isArray(settings.hooks.SubagentStart)) throw new Error(`hooks.SubagentStart in ${settingsPath} is not a list — not touching it.`);
      const list = settings.hooks.SubagentStart = settings.hooks.SubagentStart || [];
      yaEsta = JSON.stringify(list).includes('crbro-subagent');
      injectsAlready = JSON.stringify(list).includes('CRBRO_SUBAGENT_INJECT');
      if (yaEsta) return false;
      list.push({
        hooks: [{
          type: 'command',
          command: hookCmd,
          timeout: 5,
          statusMessage: 'Inyectando protocolos CRBRO en el subagente...',
        }],
      });
      return true;
    });
    if (!r0.ok) { console.error(`  ❌ ${r0.error}`); process.exit(1); }
    if (yaEsta) {
      console.log('  ✅ SubagentStart hook already installed. Script refreshed.');
      if (conInyeccion && !injectsAlready) {
        console.log('     ⚠️  The installed entry does NOT enable injection. To enable it,');
        console.log('     remove the SubagentStart entry from settings.json and re-run');
        console.log('     install-hooks --inject.');
      }
      return;
    }
    console.log('  ✅ SubagentStart hook installed.');
    console.log(`     ${settingsPath}`);
    if (r0.backup) console.log(`     backup: ${r0.backup}`);
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
  }).catch(fail);

} else if (command === 'install-mod' && process.argv.includes('--verify')) {
  // ─── Is the installed mod the one this package ships? ──────────
  // SHA-256 of every file in ~/.claude/crbro-mods/crbro-pending against
  // mods/crbro-pending here, and whether settings.json lists it. Read-only;
  // exit 1 on any difference.
  import('../dist/engine/modinstall.js').then(({ verifyMod, formatModVerify }) => {
    const here = dirname(fileURLToPath(import.meta.url));
    const m = verifyMod({ packageDir: join(here, '..', 'mods', 'crbro-pending'), home: homedir() });
    console.log(args.includes('--json') ? JSON.stringify(m, null, 2) : formatModVerify(m));
    if (!m.ok) process.exitCode = 1;
  }).catch(err => {
    console.error('  ❌ ' + (err && err.code === 'ERR_MODULE_NOT_FOUND' ? 'Build required. Run: npm run build' : err.message));
    process.exit(1);
  });

} else if (command === 'install-mod' || command === 'uninstall-mod') {
  // ─── The open-items band for Claude Code ───────────────────────
  //
  // crbro_boot installs it on its own for whoever has Claude Code, and keeps
  // its files up to date (autoInstallMod in modinstall.ts); these commands are
  // the manual way in and the way out. uninstall-mod leaves a mark in
  // ~/.claude/crbro-mods/state.json so the boot never puts it back, from any
  // client, and install-mod lifts that mark. CRBRO_MOD=0 turns the automatic
  // part off in the client whose env has it.
  //
  // mods/crbro-pending is a Claude Code mod: CRBRO's open items above the
  // prompt and /pending (alias /pendientes) with all of them as cards. It is
  // copied to ~/.claude/crbro-mods/crbro-pending and that folder is added to
  // env.CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json (";" on Windows,
  // ":" elsewhere), once. Nothing else in settings.json is touched, except the
  // mod's own language when --lang en|es is given. An earlier local copy
  // (crbro-pendientes) in that list is replaced, and uninstall-mod puts it
  // back. Same care as install-hooks:
  // BOM read, unparseable settings left alone, atomic write, idempotent.
  import('../dist/engine/modinstall.js').then(({ installMod, uninstallMod }) => {
    const here = dirname(fileURLToPath(import.meta.url));
    let lang;
    const at = args.findIndex(a => a === '--lang' || a.startsWith('--lang='));
    if (at !== -1) {
      lang = args[at].includes('=') ? args[at].split('=')[1] : args[at + 1];
      if (!['auto', 'en', 'es'].includes(lang)) {
        console.error('  ❌ --lang takes auto, en or es.');
        process.exit(1);
      }
    }
    const r = command === 'uninstall-mod'
      ? uninstallMod({ home: homedir() })
      : installMod({ packageDir: join(here, '..', 'mods', 'crbro-pending'), home: homedir(), lang });
    if (!r.ok) {
      console.error(`  ❌ ${r.error}`);
      process.exit(1);
    }
    for (const line of r.lines) console.log(line);
    // The mod is out, but the mark that keeps the boot from putting it back is not.
    if (r.markFailed) process.exitCode = 1;
  }).catch(err => {
    console.error('  ❌ ' + (err && err.code === 'ERR_MODULE_NOT_FOUND' ? 'Build required. Run: npm run build' : err.message));
    process.exit(1);
  });

} else if (command === 'install-boot') {
  // ─── The step that made the memory look broken ─────────────────
  //
  // Installing the MCP server does not call it. Without something that runs
  // crbro_boot at the start of a conversation, the brain sits there and the
  // assistant answers from nothing — the memory looks installed and behaves
  // like it was never there. Every report of "CRBRO does not remember" so far
  // has been this, not a bug in the recall.
  //
  // So this wires the start itself, per client (src/engine/installer.ts):
  //
  //   Claude Code  <config>/settings.json — SessionStart runs a command whose
  //                stdout is added to the session, telling the model to call
  //                crbro_boot first. Claude Code has no way to invoke an MCP
  //                tool from a hook, so the instruction is the mechanism.
  //   Codex        <CODEX_HOME>/config.toml gets the MCP server if it has none,
  //                and startup/tool timeouts when they are missing (a value
  //                the user set is kept). hooks/crbro-codex.mjs is copied to
  //                <CODEX_HOME>/crbro-hooks and wired on SessionStart and
  //                UserPromptSubmit: it boots the engine itself and hands the
  //                protocols to the session, or prints the notice.
  //
  // Only clients whose folder exists are touched; every file is merged, never
  // rewritten, after a timestamped backup. Idempotent. --dry-run writes nothing.
  (async () => {
    const { ctx, inst, io } = await installContext({ dryRun: args.includes('--dry-run') });
    const root = io.engineRoot(homedir(), process.env);
    const stable = existsSync(join(root, 'current.json'));
    // With a stable engine (crbro-memory install) Codex runs it; otherwise the npx form, as before.
    const wiring = stable
      ? { command: process.execPath, args: [join(root, 'crbro.mjs')], replaceCommand: false, engineArg: root }
      : { command: 'npx', args: ['-y', 'crbro-memory'], replaceCommand: false };
    const steps = inst.wireBoot(ctx, ['claude-code', 'codex'], wiring);
    if (ctx.dryRun) console.log('  Dry run: nothing is written.\n');
    for (const line of inst.formatSteps(steps)) console.log(line);
    console.log('');
    const wired = steps.filter(s => s.status !== 'skipped');
    if (!wired.length) console.log(`  ⚠️  Neither ${io.claudeDir(homedir(), process.env)} nor ${io.codexHome(homedir(), process.env)} was found, so nothing was wired.`);
    console.log('');
    console.log('  Other tools (Cursor, Windsurf, Antigravity…) have no session hooks.');
    console.log('  Put this line in their always-on rules file (.cursorrules, .windsurfrules,');
    console.log('  User Rules) and it does the same job:');
    console.log('');
    console.log(`    ${ctx.bootNotice}`);
    console.log('');
    if (steps.some(s => s.status === 'done')) console.log('  Restart the tool, then check a new conversation actually boots CRBRO.');
    if (!stable && steps.some(s => s.client === 'Codex' && s.status !== 'skipped')) {
      console.log('  For a stable engine that clients start without npx: npx crbro-memory install');
    }
    console.log('');
    if (inst.failed(steps)) process.exitCode = 1;
  })().catch(fail);

} else if (command === 'install' || command === 'uninstall') {
  // ─── One command in, one command out ───────────────────────────
  //
  // install: the engine copied to a stable folder (~/.crbro-engine, or
  // --engine-dir), registered in each client as `node <launcher>`, the session
  // start wired, installed hooks brought up to date. uninstall: the reverse,
  // only what CRBRO added; backups kept; the brain is never touched.
  // src/engine/installer.ts does the work; this prints it.
  (async () => {
    const { ctx, inst } = await installContext({ dryRun: args.includes('--dry-run'), engineDir: flagValue('--engine-dir') });
    const spec = flagValue('--clients');
    let clients;
    try {
      clients = inst.parseClients(spec, () => inst.detectClients(ctx.home, ctx.env, ctx.platform, ctx.claude));
    } catch (e) {
      usageError(e.message);
    }
    const json = args.includes('--json');
    let report, brain = null;
    if (command === 'install') {
      report = inst.install(ctx, clients);
    } else {
      const [{ resolveBrainDir }, { uninstallMod }] = await Promise.all([import('../dist/engine/brain.js'), import('../dist/engine/modinstall.js')]);
      brain = resolveBrainDir(process.env, () => {});
      report = inst.uninstall(ctx, clients, {
        brainDir: brain, removeEngine: !spec || spec === 'auto',
        uninstallMod: home => uninstallMod({ home }),
      });
    }
    if (json) {
      console.log(JSON.stringify({ command, dry_run: ctx.dryRun, clients, ...report }, null, 2));
    } else {
      const names = clients.map(c => inst.CLIENT_NAMES[c]).join(', ') || 'none found';
      console.log('');
      console.log(`  🧠 CRBRO ${command}${ctx.dryRun ? ' — dry run: nothing is written' : ''} · clients: ${names}`);
      console.log('');
      for (const line of inst.formatSteps(report.steps)) console.log(line);
      console.log('');
      if (command === 'install') {
        if (report.engine) console.log(`  Clients start: ${process.execPath} ${report.engine.launcher}`);
        console.log('  Restart each client; a new conversation boots CRBRO on its own (Claude Code, Codex) or');
        console.log('  with this line in the tool\'s always-on rules (Cursor, Claude Desktop, others):');
        console.log(`    ${ctx.bootNotice}`);
        console.log('  Undo everything with: npx crbro-memory uninstall');
      } else {
        console.log(`  Your brain was not touched: ${brain}`);
        console.log('  Delete that folder yourself if you want the memory gone too. Credentials stay in the OS');
        console.log('  keychain (npx crbro-memory secret list); the auto-miner, if you set it up, goes with');
        console.log('  npx crbro-memory remove-miner. Servers already running stop when their client restarts.');
      }
      console.log('');
    }
    if (inst.failed(report.steps)) process.exitCode = 1;
  })().catch(fail);

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

} else if (command === 'backup') {
  // ─── Backup: one gzipped file per copy, rotated ────────────────
  // `backup` makes one · `backup list` · `backup restore FILE [--into DIR]`
  const sub = args[1] && !args[1].startsWith('--') ? args[1] : 'create';
  const flag = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : undefined; };
  Promise.all([import('../dist/engine/brain.js'), import('../dist/engine/backup.js')]).then(async ([{ BrainPaths }, bk]) => {
    const paths = new BrainPaths();
    const dir = flag('--dir') || bk.resolveBackupDir(paths.root);
    const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
    try {
      if (sub === 'create') {
        const keep = flag('--keep') ? Number(flag('--keep')) : undefined;
        const r = await bk.createBackup(paths, { dir, keep });
        console.log('');
        console.log(`  ✅ Backup written: ${r.path}`);
        console.log(`     ${r.counts.neurons} neurons · ${r.counts.sessions} sessions · ${r.counts.synapses} synapses · ${kb(r.counts.bytes)} of text → ${kb(r.size_bytes)} on disk`);
        if (r.rotated_out.length) console.log(`     Rotated out: ${r.rotated_out.join(', ')}`);
        console.log('     Left out on purpose: the quarantine, machine tokens, the search index and the semantic runtime.');
        if (!process.env.CRBRO_BACKUP_DIR) {
          console.log('');
          console.log('  ⚠️  This folder is on the same disk as the brain. It survives a bad write or a wrong');
          console.log('     forget, not a dead disk. Point CRBRO_BACKUP_DIR at a folder that is already synced');
          console.log('     (Drive in mirror mode, Dropbox, an external disk) to cover that too.');
        }
        console.log('');
      } else if (sub === 'list') {
        const all = await bk.listBackups(dir);
        console.log('');
        console.log(`  Backups in ${dir}`);
        if (!all.length) console.log('    (none yet — run: npx crbro-memory backup)');
        for (const b of all) console.log(`    ${b.file}   ${b.created.slice(0, 16).replace('T', ' ')} UTC   ${kb(b.size_bytes)}`);
        console.log('');
      } else if (sub === 'restore') {
        const file = args[2];
        if (!file || file.startsWith('--')) {
          console.error('  Usage: npx crbro-memory backup restore FILE [--into DIR]');
          process.exit(1);
        }
        const src = existsSync(file) ? file : join(dir, file);
        const into = flag('--into') || join(homedir(), `.crbro-restored-${Date.now()}`);
        const r = await bk.restoreBackup(src, into);
        console.log('');
        console.log(`  ✅ Restored ${r.files} files into ${r.into}`);
        console.log('     Nothing was written over your live brain. To switch to the restored copy, close every');
        console.log('     client using CRBRO, move ~/.crbro aside, rename this folder to ~/.crbro, then run:');
        console.log('       npx crbro-memory reindex');
        console.log('');
      } else {
        console.error('  Usage: npx crbro-memory backup [list | restore FILE [--into DIR]] [--dir DIR] [--keep N]');
        process.exit(1);
      }
    } catch (err) {
      console.error(`  ❌ ${err.message}`);
      process.exit(1);
    }
  }).catch(err => {
    console.error('  ❌ Build required. Run: npm run build');
    console.error('  ', err.message);
    process.exit(1);
  });

} else {
  // ─── Default: start MCP server ─────────────────────────────────
  // Only with no arguments, or --daemon / --proxy / --stdio: anything else
  // was checked by preDispatch() and rejected.
  import('../dist/index.js').catch(fail);
}

// ─── Help ────────────────────────────────────────────────────────
function printHelp() {
  const L = [
    '',
    '  🧠 CRBRO — Persistent Neural Memory for AI',
    '  ═══════════════════════════════════════════',
    '',
    '  Setup:',
    '    npx crbro-memory install          Install for every MCP client found: stable engine in ~/.crbro-engine,',
    '                                      registrations (Codex with timeouts), session start. --dry-run shows the plan',
    '    npx crbro-memory uninstall        Remove what install added; backups kept, the brain never touched. --dry-run',
    '    npx crbro-memory init             Initialize the brain, detect clients, install semantic recall',
    '    npx crbro-memory install-boot     Make the memory load itself in every conversation (Claude Code, Codex)',
    '    npx crbro-memory status           Show brain status',
    '    npx crbro-memory doctor [--json]  Read-only diagnostics: brain, clients, hooks, daemon leftovers, backups',
    '',
    '  Auto-Mining:',
    '    npx crbro-memory mine [dir]       One-shot mining of editor artifacts',
    '    npx crbro-memory setup-miner      Install scheduled auto-miner',
    '    npx crbro-memory miner-status     Check auto-miner status',
    '    npx crbro-memory remove-miner     Remove auto-miner',
    '',
    '  Backup (one gzipped file per copy; consolidate makes one a day on its own):',
    '    npx crbro-memory backup           Back the brain up now (keeps the newest 7)',
    '    npx crbro-memory backup list      What there is, newest first',
    '    npx crbro-memory backup restore FILE   Unpack into a NEW folder, never over the live brain',
    '    CRBRO_BACKUP_DIR=<synced folder>  Put them somewhere that survives the disk',
    '',
    '  Hooks (Claude Code; copies in <config>/crbro-hooks refresh themselves when CRBRO updates, unless edited):',
    '    npx crbro-memory install-hooks           SubagentStart hook, inert unless --inject (CRBRO_SUBAGENT_INJECT=full)',
    '    npx crbro-memory install-hooks --guard   PreToolUse guard: stored lessons for this project speak before a shell command',
    '    npx crbro-memory guard "<command>"       What it would say for a command · --rebuild writes the index',
    '    npx crbro-memory install-hooks --compact     PreCompact checkpoint + SessionStart that picks it back up',
    '    npx crbro-memory uninstall-hooks --compact   Remove both and put back what was replaced',
    '    npx crbro-memory install-hooks --verify      SHA-256 of the installed hooks and mod against this package (read-only)',
    '    npx crbro-memory install-mod [--lang en|es|auto]  Claude Code band + /pending with the open items (Claude Code 2.1.286+)',
    '                                                 crbro_boot installs and updates it on its own; CRBRO_MOD=0 turns that off',
    '    npx crbro-memory uninstall-mod                Remove the mod and its CLAUDE_CODE_PLUGIN_DIRS entry; never put back on its own',
    '    npx crbro-memory install-mod --verify         SHA-256 of the installed mod against this package (read-only)',
    '',
    '  Looking back at Claude Code sessions (read-only; last 7 days unless --days N, 0 = all):',
    '    npx crbro-memory usage [--session ID] [--project DIR] [--json]   Tokens per model and session, subagents apart',
    '    npx crbro-memory postmortem [--max N] [--json]   Candidate lessons: corrections, failing tools, repeats',
    '',
    '  Daemon (opt-in): one process owns the brain for every client — one index, one model, one writer:',
    '    npx crbro-memory daemon on | off  Switch every client of this brain, the next time each starts',
    '    npx crbro-memory daemon status    Is it on, who is running, how much it holds',
    '    npx crbro-memory daemon stop      Stop it; clients start a new one on demand',
    '',
    '  Search:',
    '    npx crbro-memory reindex          Rebuild the search index',
    '    npx crbro-memory eval             Measure retrieval against <brain>/.eval/queries.json',
    '',
    '  Semantic recall (installed by init, ~500 MB once per machine; init --no-semantic skips it, CRBRO_SEMANTIC=0 turns it off):',
    '    npx crbro-memory semantic status  Runtime, model and whether it is enabled',
    '    npx crbro-memory semantic install Install transformers.js into ~/.crbro/.semantic and embed the brain',
    '    npx crbro-memory semantic build   Embed the whole brain again',
    '',
    '  Credentials (per machine, sealed in the OS keychain):',
    '    npx crbro-memory secret set NAME     Store one; the value is read from stdin, never argv',
    '    npx crbro-memory secret list         Names only, never values',
    '    npx crbro-memory secret get NAME     Print one; pipe it to keep it off the screen',
    '    npx crbro-memory secret remove NAME --yes',
    '    npx crbro-memory secret status       Which keychain this machine offers',
    '',
    '  Server:',
    '    npx crbro-memory                  Start the MCP server (stdio)',
    '    npx crbro-memory --version        Print the version',
    '    npx crbro-memory <command> --help Help for one command; nothing runs',
    '',
    '  Exit codes: 0 done · 1 failed · 2 the command line is wrong (unknown command or option).',
    '  Open source (MIT) — https://github.com/Octonove/crbro-memory',
    '',
  ];
  console.log(L.join('\n'));
}
