#!/usr/bin/env node

// ─── CRBRO CLI ───────────────────────────────────────────────────
// Command-line interface for CRBRO memory system
// Supports: init, status, mine, setup-miner, miner-status,
//           remove-miner, and MCP server mode (default)

import { platform, homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';

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
      console.log(`  Version:         ${manifest.version}`);
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

} else if (command === '--help' || command === '-h') {
  // ─── Help ──────────────────────────────────────────────────────
  console.log('');
  console.log('  🧠 CRBRO — Persistent Neural Memory for AI');
  console.log('  ═══════════════════════════════════════════');
  console.log('');
  console.log('  Setup:');
  console.log('    npx crbro-memory init             Initialize brain + detect IDEs');
  console.log('    npx crbro-memory status           Show brain status');
  console.log('');
  console.log('  Auto-Mining:');
  console.log('    npx crbro-memory mine [dir]       One-shot mining of artifacts');
  console.log('    npx crbro-memory setup-miner      Install scheduled auto-miner');
  console.log('    npx crbro-memory miner-status     Check auto-miner status');
  console.log('    npx crbro-memory remove-miner     Remove auto-miner');
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
