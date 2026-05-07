#!/usr/bin/env node

// ─── CRBRO CLI ───────────────────────────────────────────────────
// Command-line interface for CRBRO memory system

const args = process.argv.slice(2);
const command = args[0];

if (command === 'init') {
  // Initialize brain
  import('../dist/engine/brain.js').then(async ({ Brain }) => {
    const brain = new Brain();
    const manifest = await brain.initialize();
    console.log('🧠 CRBRO brain initialized!');
    console.log(`   Path: ${manifest.brain_path}`);
    console.log('');
    console.log('Add CRBRO to your MCP config:');
    console.log('');
    console.log(JSON.stringify({
      "mcpServers": {
        "crbro": {
          "command": "npx",
          "args": ["-y", "crbro-memory"]
        }
      }
    }, null, 2));
  }).catch(console.error);

} else if (command === 'status') {
  // Show brain status
  import('../dist/engine/brain.js').then(async ({ Brain }) => {
    const brain = new Brain();
    try {
      const manifest = await brain.getManifest();
      console.log('🧠 CRBRO Brain Status');
      console.log(`   Version:  ${manifest.version}`);
      console.log(`   Path:     ${manifest.brain_path}`);
      console.log(`   Neurons:  ${manifest.total_neurons}`);
      console.log(`   Synapses: ${manifest.total_synapses}`);
      console.log(`   Sessions: ${manifest.total_sessions}`);
      console.log(`   Last Boot: ${manifest.last_boot || 'never'}`);
    } catch {
      console.log('🧠 CRBRO brain not initialized. Run: npx crbro-memory init');
    }
  }).catch(console.error);

} else if (command === 'activate') {
  // Activate license key
  const key = args[1];
  if (!key) {
    console.log('❌ Usage: npx crbro-memory activate SYNTH-ZERO-XXXX-XXXX-XXXX');
    console.log('');
    console.log('Get your license key at https://synthetica-decks.web.app');
    process.exit(1);
  }

  import('../dist/engine/brain.js').then(async ({ Brain }) => {
    const brain = new Brain();
    try {
      await brain.getManifest(); // Ensure brain exists
    } catch {
      console.log('🧠 Brain not initialized. Initializing now...');
      await brain.initialize();
    }

    // Validate key format
    if (!key.startsWith('SYNTH-ZERO-') || key.length < 20) {
      console.log('❌ Invalid license key format.');
      console.log('   Keys start with SYNTH-ZERO- and are at least 20 characters.');
      process.exit(1);
    }

    // Persist key in manifest
    await brain.updateManifest({ license_key: key });
    console.log('✅ License key activated!');
    console.log('');
    console.log('   🔓 Premium features unlocked:');
    console.log('      • crbro_global_map  — Neural cluster visualization');
    console.log('      • crbro_maintenance — Automated brain optimization');
    console.log('');
    console.log('   Restart your IDE to apply changes.');
  }).catch(console.error);

} else if (command === '--help' || command === '-h') {
  console.log('🧠 CRBRO — Persistent Neural Memory for AI');
  console.log('');
  console.log('Usage:');
  console.log('  npx crbro-memory              Start MCP server (stdio)');
  console.log('  npx crbro-memory init         Initialize brain directory');
  console.log('  npx crbro-memory status       Show brain status');
  console.log('  npx crbro-memory activate KEY Activate premium license');
  console.log('  npx crbro-memory --help       Show this help');
  console.log('');
  console.log('Part of Synthetica Decks — https://synthetica-decks.web.app');

} else {
  // Default: start MCP server
  import('../dist/index.js').catch(console.error);
}
