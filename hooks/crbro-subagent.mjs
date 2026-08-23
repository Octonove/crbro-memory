#!/usr/bin/env node
// CRBRO — Claude Code SubagentStart hook
//
// SessionStart context is parent-thread only and never reaches subagents, so
// without this every Task-spawned agent runs without the behavioral protocols
// the session was booted with: the anti-hallucination and verification rules
// govern the orchestrator while the agents doing the unsupervised work run
// bare. (Observed live: a subagent-written audit claimed 27 premium prompts
// were exposed; zero were. The protocols existed — they just never reached
// the author.)
//
// The ruleset is read from the SAME source crbro_boot reads: the protocol_*
// neurons in the brain's cortex. One source of truth, so this hook can never
// drift from what the main session was given.
//
// Scoping (opt-in): set CRBRO_SUBAGENT_MATCHER to a regex and the protocols
// are injected only into subagents whose agent_type matches. Unanchored,
// case-insensitive. Invalid regex or missing agent_type fail OPEN (inject):
// scoping must never silently drop the integrity layer.
//
// Failure contract: this hook never blocks a session. Any error — unreadable
// brain, bad JSON, stdin that never ends (the Windows PowerShell wrapper can
// swallow piped JSON so 'end' never fires) — degrades to the embedded
// fallback rules or to silence, and always exits 0.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// The floor: if the brain is unreadable, subagents still get the core
// discipline. Deliberately short — it is a parachute, not the product.
const FALLBACK_RULES = [
  'You operate under integrity protocols:',
  '1. Never invent URLs, file paths, function signatures, statistics or facts. Unsure = say so.',
  '2. Verify a resource exists before acting on it; report failures instead of retrying blindly.',
  '3. Never present uncertain information as certain. "I do not know" is a valid answer.',
  '4. Do exactly what was asked - no silent scope changes.',
  '5. Re-read your own output for errors before returning it.',
].join('\n');

function brainDir() {
  if (process.env.CRBRO_BRAIN_PATH) return process.env.CRBRO_BRAIN_PATH;
  return join(homedir(), '.crbro');
}

/** Same selection and assembly as Brain.loadProtocols(), kept dependency-free. */
function loadProtocolBlock() {
  const cortex = join(brainDir(), 'cortex');
  const protocols = [];
  let files;
  try {
    files = readdirSync(cortex);
  } catch {
    return null;
  }
  for (const file of files) {
    if (!file.startsWith('protocol_') || !file.endsWith('.json')) continue;
    try {
      const raw = readFileSync(join(cortex, file), 'utf8').replace(/^﻿/, '');
      const neuron = JSON.parse(raw);
      const tags = Array.isArray(neuron.tags) ? neuron.tags : [];
      const prioTag = tags.find(t => typeof t === 'string' && t.startsWith('priority:'));
      const priority = prioTag ? parseInt(prioTag.split(':')[1], 10) || 5 : 5;
      const instructions = (neuron.facts || [])
        // Only active facts — same filter as Brain.loadProtocols(). Without
        // it, a protocol the user corrected or retracted keeps being injected
        // into every subagent, alongside its replacement.
        .filter(f => f && (!f.status || f.status === 'active'))
        .map(f => f.text || '')
        .filter(Boolean)
        .join('\n\n');
      if (instructions.trim()) {
        protocols.push({ name: neuron.name || neuron.id, priority, instructions });
      }
    } catch {
      // One unreadable protocol must not cost the rest.
    }
  }
  if (protocols.length === 0) return null;
  protocols.sort((a, b) => b.priority - a.priority);
  return protocols
    .map(p => `## ${p.name} [priority: ${p.priority}]\n\n${p.instructions}`)
    .join('\n\n');
}

function inject() {
  let block;
  try {
    block = loadProtocolBlock();
  } catch {
    block = null;
  }
  const context =
    '⚡ ACTIVE PROTOCOLS — These are MANDATORY behavioral directives for this ' +
    'agent, the same ones governing the parent session:\n\n' +
    (block || FALLBACK_RULES);
  try {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: context },
    }));
  } catch {
    // A stdout error at hook exit must not surface as a hook failure.
  }
}

// A bad regex must never crash the hook; treat it as "no matcher" and inject.
let matcherRe = null;
try {
  if (process.env.CRBRO_SUBAGENT_MATCHER) {
    matcherRe = new RegExp(process.env.CRBRO_SUBAGENT_MATCHER, 'i');
  }
} catch {
  matcherRe = null;
}

// No matcher → synchronous, stdin-independent path. On Windows the PowerShell
// wrapper can swallow the piped JSON so stdin 'end' never fires; the default
// path must not wait on stdin or it would stall every subagent spawn.
if (!matcherRe) {
  inject();
  process.exit(0);
}

// Matcher set → read agent_type from stdin and skip only on a definite
// mismatch. Missing/unparseable agent_type, a stdin error, or the timeout all
// fail open (inject).
let input = '';
let done = false;

function finish() {
  if (done) return;
  done = true;
  let agentType = '';
  try {
    agentType = String(JSON.parse(input.replace(/^﻿/, '')).agent_type || '').trim();
  } catch {
    // Unparseable payload — fall through and inject to be safe.
  }
  if (agentType && !matcherRe.test(agentType)) {
    process.exit(0);
  }
  inject();
}

process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => { finish(); process.exit(0); });
process.stdin.on('error', () => { finish(); process.exit(0); });
setTimeout(() => { finish(); process.exit(0); }, 1000).unref();
