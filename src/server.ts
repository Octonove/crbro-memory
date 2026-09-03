// ─── CRBRO MCP Server ────────────────────────────────────────────
// Main server with all 23 tools registered.
//
// Every tool goes through registerTool with a title, MCP annotations
// (readOnlyHint / destructiveHint / idempotentHint / openWorldHint) and, for
// the read tools with a stable shape, an outputSchema honoured with
// structuredContent. The descriptions state what the tool does, when to use
// it over its siblings, its side effects and what it returns — and nothing
// else: the discipline of using the memory well is said once, at boot, in
// memory_discipline, because these definitions are paid on every request in
// clients that load all tools (measured: ~5.4k tokens for the 23).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Brain } from './engine/brain.js';
import { Cortex } from './engine/cortex.js';
import { Synapses } from './engine/synapses.js';
import { HeatEngine } from './engine/heat.js';
import { Hippocampus } from './engine/hippocampus.js';
import { Prefrontal } from './engine/prefrontal.js';
import { SearchEngine } from './search/index.js';
import { Maintenance } from './engine/maintenance.js';
import {
  createSpace, joinSpace, listSpaces, readSpace, prepareShare, commitShare,
  syncSpaceNow, syncAll, getIdentity, attachSync,
} from './sync/space.js';
import {
  detectBackend, setSecret, getSecret, listSecrets, removeSecret, KeychainUnavailable,
} from './engine/keychain.js';

/**
 * The version of CRBRO that is actually running. The manifest carries its own
 * version, but that one stamps the brain FORMAT and has not moved since 1.0.0
 * — reporting it as "the version" told every user the same thing regardless of
 * what they had installed, which is no use to anyone deciding whether to
 * update.
 */
function runningVersion(): string {
  try {
    return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'crbro-memory',
    version: runningVersion(),
  });

  // ─── Initialize engines ──────────────────────────────────────
  const brain = new Brain();
  const cortex = new Cortex(brain);
  const synapses = new Synapses(brain);
  const heatEngine = new HeatEngine(brain);
  const hippocampus = new Hippocampus(brain);
  const prefrontal = new Prefrontal(brain);
  const searchEngine = new SearchEngine(brain);
  const maintenance = new Maintenance(brain, cortex, synapses, heatEngine, hippocampus, prefrontal, searchEngine);

  // Every write to the cortex reaches the index, whoever made it. Wiring this
  // once here - instead of calling indexNeuron from each caller - is what fixes
  // the miner path, which used to write straight to disk. Result on the
  // reference brain: only 106 of 1,183 neurons were searchable.
  cortex.setIndexer(neuron => searchEngine.indexNeuron(neuron));

  // When a neuron belongs to a shared space, every write also appends a note
  // to this machine's own log. Nobody ever writes to anyone else's file, so
  // two people working at once have nothing to collide over.
  attachSync(brain, cortex);

  // v1.4.0: CRBRO is fully free — no license, no network calls. The former
  // license engine (Firestore-backed freemium) lives in git history before
  // that version if it is ever needed again.

  // ═══════════════════════════════════════════════════════════════
  // TOOL 1: crbro_boot — Boot sequence
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_boot',
    {
      title: 'Boot the brain',
      description: 'Boot the CRBRO brain — call it FIRST in every conversation, before any other work. Loads persistent memory from earlier sessions: hot topics, active context with open_items and recently_closed (never report recently_closed as pending; verify open_items before repeating them), recent session history, counts, any active protocols as a protocol_enforcement block you must follow, and memory_discipline — the rules for using this memory well. Initializes the brain on first use, readies the search index and syncs shared team spaces (offline is a normal outcome, not an error). Skipping it means losing all accumulated context.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const result = await brain.boot();
        // Initialize search engine
        await searchEngine.init();

        // Pull whatever the team learned, on a short budget. Being offline is
        // a normal outcome, never an error: the local memory is complete on
        // its own and anything pending goes out on the next sync.
        const equipos = await syncAll(brain, cortex, 5_000);

        const response: any = { ...result };

        // Inject protocol enforcement.
        // The instruction text goes in ONE place. It used to be emitted twice --
        // inside active_protocols[].instructions and again here -- which on a
        // normal brain spent 1,407 of 2,713 tokens saying the same thing twice
        // to the same reader.
        if (result.active_protocols && result.active_protocols.length > 0) {
          const protocolBlock = result.active_protocols.map((p: any) =>
            `## 📋 ${p.name} [priority: ${p.priority}]\n\n${p.instructions}`
          ).join('\n\n───────────────────\n\n');

          response.active_protocols = result.active_protocols.map((p: any) => ({
            id: p.id, name: p.name, priority: p.priority, source: p.source,
          }));

          response.protocol_enforcement =
            '⚡ ACTIVE PROTOCOLS — These are MANDATORY behavioral directives. ' +
            'You MUST follow them in every interaction:\n\n' + protocolBlock;
        }

        // Pending items: say plainly what is open and what was just closed, so a
        // stale to-do list carried over in a conversation summary is not repeated
        // back to the user as if it were still live.
        if ((result.recently_closed || []).length > 0) {
          response.pending_guidance =
            'ℹ️ `recently_closed` lists items already resolved - do not report them as pending. ' +
            'And treat `open_items` as a starting point, not gospel: an item can be finished without ' +
            'anyone closing it here, so verify before repeating it back to the user.';
        }

        if (equipos.length > 0) {
          response.shared_spaces = equipos.map(e => ({
            space: e.space,
            state: e.state,
            neurons_updated: e.neurons_touched.length,
            summary: e.message,
          }));
        }

        // How to use this memory well — said once here, at boot, instead of
        // repeated inside every tool description. Measured with a real
        // tools/list: the 23 definitions cost ~6.3k tokens on every request
        // in clients that load all tools; this paragraph costs ~200, once.
        response.memory_discipline =
          'Before crbro_learn, crbro_recall: what you are about to save may already exist — then pass ' +
          'supersedes instead of adding a sibling (two versions of one fact compete on recall as equals). ' +
          'Structure — paths, what serves what, traps — goes in crbro_map, not in facts; anything derivable ' +
          'from the repo or git history is not worth storing. Write facts dense and self-contained: they are ' +
          'recalled without this conversation, and add keywords: the words a future question may use that ' +
          'the text lacks. On recall, ask several ways (queries) before concluding a thing is not stored. ' +
          'type:error keeps a mistake with its fix; type:debt keeps a ' +
          'deliberate deferral with its ceiling and revisit trigger. Credentials never go in the brain: ' +
          'crbro_secret, then record only the NAME. Recall results carry confidence — "weak" means the match ' +
          'covers little of the question, verify before relying on it — and when two facts disagree, prefer ' +
          'the more recent. Call crbro_consolidate before the conversation ends; it logs the session too.';

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(response, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `CRBRO boot error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 2: crbro_status — Brain status
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_status',
    {
      title: 'Brain status',
      description: 'Read-only snapshot: CRBRO version, brain format, neuron/synapse/session totals, brain path, last boot and last consolidation. Loads no memory — that is crbro_boot.',
      inputSchema: {},
      outputSchema: {
        crbro_version: z.string(),
        brain_format: z.string().optional(),
        total_neurons: z.number(),
        total_synapses: z.number(),
        total_sessions: z.number(),
        brain_path: z.string().optional(),
        last_boot: z.string().nullable().optional(),
        last_consolidation: z.string().nullable().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const manifest = await brain.getManifest();
        const payload = {
          crbro_version: runningVersion(),
          brain_format: manifest.version,
          total_neurons: manifest.total_neurons,
          total_synapses: manifest.total_synapses,
          total_sessions: manifest.total_sessions,
          brain_path: manifest.brain_path,
          last_boot: manifest.last_boot,
          last_consolidation: manifest.last_consolidation,
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `CRBRO status error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 3: crbro_learn — Add knowledge to the brain
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_learn',
    {
      title: 'Learn something',
      description: 'Store a fact, decision, pattern, preference, error or debt on a topic. The neuron is created if it does not exist; pass neuron_id (from crbro_recall) to target an exact one and skip name matching. Recall first: to replace an outdated fact pass its id in supersedes rather than adding a sibling. A fact stored verbatim before is skipped silently; decisions always append; preferences never leave this machine. Credential-like values are replaced with a marker before touching disk and listed in redacted — store the value with crbro_secret and record only its name. Add keywords a future question may use that the text lacks (synonyms, the other language, the generic name of the product). Returns neuron_id, action (created|updated), superseded count, near_duplicates (stored anyway; retire the old telling), supersedes_unmatched (those targets are still live — retire them with crbro_revise) and running totals.',
      inputSchema: {
        topic: z.string().describe('Topic name, e.g. "OctoChat", "Firebase", "SEO Strategy".'),
        type: z.enum(['fact', 'decision', 'pattern', 'preference', 'error', 'debt']).describe('error = a mistake plus its correction, in one entry. debt = a deliberate deferral: what was NOT done on purpose, its ceiling, and the revisit condition, e.g. "DEFERRED: protecting the PDFs. CEILING: anyone can download them without signing up. REVISIT WHEN: the signup flow works."'),
        content: z.string().describe('The knowledge itself. Dense and self-contained: it is recalled without this conversation as context.'),
        confidence: z.number().min(0).max(1).optional().describe('0.0-1.0, default 1.0. Facts only.'),
        domain: z.string().optional().describe('Domain, e.g. "proyectos-web". Applied when the neuron is created; on an existing neuron it only replaces the default "general".'),
        rationale: z.string().optional().describe('Why the decision was taken. Stored and indexed with it; ignored for other types.'),
        neuron_id: z.string().optional().describe('Exact neuron id from crbro_recall, e.g. "project_octochat". Skips name matching entirely.'),
        supersedes: z.array(z.string()).optional().describe('Facts this one replaces: their ids or exact text. They leave recall but stay in the file. Unmatched targets are reported and stay live.'),
        keywords: z.array(z.string()).optional().describe('Facts only. 2-5 words a future question may use that the text does not contain: synonyms, the other language, the generic name of the product named. Indexed with the fact, never shown. The same text again with new keywords merges them.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {        const result = await cortex.learn(args.topic, args.type, args.content, {
          confidence: args.confidence,
          domain: args.domain,
          rationale: args.rationale,
          neuronId: args.neuron_id,
          supersedes: args.supersedes,
          keys: args.keywords,
        });
        // Indexing happens inside cortex.learn, through the indexer hook.

        // `neuron` is only null when the caller asked not to create one,
        // which the MCP path never does. Guard anyway so the types stay honest.
        if (!result.neuron) {
          return {
            content: [{
              type: 'text' as const,
              text: `No neuron matched "${args.topic}" and none was created.`,
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              neuron_id: result.neuron.id,
              action: result.action,
              superseded_facts: result.superseded,
              near_duplicates: result.near_duplicates.length > 0
                ? result.near_duplicates
                : undefined,
              near_duplicates_warning: result.near_duplicates.length > 0
                ? 'Stored, but this closely resembles the fact(s) listed above. If this is ' +
                  'a newer telling of the same thing, retire the old one: pass its id in ' +
                  '`supersedes` next time, or crbro_revise it now. Two versions of one fact ' +
                  'keep competing on recall as equals.'
                : undefined,
              supersedes_unmatched: result.supersedes_unmatched.length > 0
                ? result.supersedes_unmatched
                : undefined,
              supersedes_warning: result.supersedes_unmatched.length > 0
                ? 'These supersedes targets matched NO active fact — the old version is ' +
                  'still live and will keep appearing on recall. Find its id with ' +
                  'crbro_recall and retire it with crbro_revise.'
                : undefined,
              redacted: result.redacted.length > 0 ? result.redacted : undefined,
              redaction_note: result.redacted.length > 0
                ? `Stored, but ${result.redacted.length} credential(s) were replaced with a marker: ` +
                  `${result.redacted.join(', ')}. The sentence around them was kept. ` +
                  'Do not try to store the value again. Offer the user crbro_secret instead: ' +
                  'it puts the credential in the OS keychain, and then you record only its name here.'
                : undefined,
              total_facts: result.neuron.facts.length,
              total_decisions: result.neuron.decisions.length,
              total_patterns: result.neuron.patterns.length,
              message: result.action === 'created'
                ? `New neuron "${result.neuron.name}" created in ${result.neuron.domain}`
                : `Updated neuron "${result.neuron.name}" — ${args.type} added` +
                  (result.superseded > 0 ? `, ${result.superseded} older fact(s) superseded` : ''),
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `CRBRO learn error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 4: crbro_neuron — Read a specific neuron
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_neuron',
    {
      title: 'Read a neuron',
      description: 'Read one neuron by id or name: facts newest first (superseded and retracted hidden unless include_superseded), decisions, patterns, preferences, errors, debts, entry dates, connections, heat and system map. Reading bumps its access stats. Big neurons are paged — use offset rather than pulling everything at once. To find the right neuron first, use crbro_recall.',
      inputSchema: {
        id: z.string().describe('Neuron id (e.g. "project_octochat") or name (e.g. "OctoChat").'),
        limit: z.number().optional().describe('Facts to return: default 40, max 200.'),
        offset: z.number().optional().describe('Facts to skip. Facts come newest first.'),
        include_superseded: z.boolean().optional().describe('Also return superseded and retracted facts (default false).'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {        // Try by ID first, then by name
        let neuron = await cortex.get(args.id);
        if (!neuron) {
          neuron = await cortex.findByName(args.id);
          if (neuron) {
            // Touch the found neuron
            neuron = await cortex.get(neuron.id);
          }
        }

        if (!neuron) {
          return {
            content: [{
              type: 'text' as const,
              text: `Neuron not found: "${args.id}". Use crbro_neurons to list available neurons.`,
            }],
          };
        }

        // A whole neuron can be enormous - the biggest on the reference brain
        // serialises to 528,836 characters, more than most models can hold - so
        // facts are paged instead of dumped.
        const limit = Math.min(Math.max(args.limit ?? 40, 1), 200);
        const offset = Math.max(args.offset ?? 0, 0);

        const visible = (neuron.facts || []).filter(f =>
          args.include_superseded ? true : (f.status !== 'superseded' && f.status !== 'retracted')
        );
        const ordered = [...visible].sort((a, b) =>
          String(b.added || '').localeCompare(String(a.added || ''))
        );
        const page = ordered.slice(offset, offset + limit);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ...neuron,
              facts: page,
              facts_pagination: {
                total: ordered.length,
                returned: page.length,
                offset,
                has_more: offset + page.length < ordered.length,
                order: 'newest first',
                hidden_superseded: (neuron.facts || []).length - visible.length,
              },
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `CRBRO neuron error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 5: crbro_neurons — List neurons
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_neurons',
    {
      title: 'List neurons',
      description: 'List neurons, hottest first, filtered by domain, type or min_heat. Read-only. Each row: id, name, domain, type, heat, last_accessed, facts_count. To search content rather than list topics, use crbro_recall.',
      inputSchema: {
        domain: z.string().optional().describe('Only this domain, e.g. "proyectos-web".'),
        type: z.enum(['project', 'tech', 'lang', 'person', 'domain', 'process', 'protocol']).optional().describe('Only this neuron type.'),
        min_heat: z.number().optional().describe('Minimum heat, 0.0-1.0. Heat blends access frequency, recency and connectivity.'),
        limit: z.number().optional().describe('Max rows (default 50).'),
      },
      outputSchema: {
        total: z.number(),
        neurons: z.array(z.object({
          id: z.string(), name: z.string(), domain: z.string(), type: z.string(),
          heat: z.number(), last_accessed: z.string(), facts_count: z.number(),
        }).loose()),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {        const neurons = await cortex.list({
          domain: args.domain,
          type: args.type,
          min_heat: args.min_heat,
          limit: args.limit,
        });

        const payload = { total: neurons.length, neurons };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `CRBRO neurons error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 6: crbro_recall — Search the brain
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_recall',
    {
      title: 'Recall',
      description: 'Search everything saved in earlier sessions — the full text of facts, decisions, patterns, preferences, errors, debts and system maps, not just topic names. Read-only. One result per neuron: its best matching chunk (matching_content, matched_kind, matched_added), a confidence label (weak = the match covers little of the question; verify before relying on it) and, for the top results, also_matched — the neuron\'s next best lines. Superseded and retracted facts never surface. Call it before asking the user something they may already have told you, and before crbro_learn. If nothing matches or all is weak, pass 2-4 alternative phrasings in queries (fused by rank), or retry with fewer, more distinctive words (names, ids, filenames). has_map:true means the neuron keeps a system map — read it with crbro_map before touching that system.',
      inputSchema: {
        query: z.string().describe('What to look for, e.g. "Firebase authentication setup". Fewer, distinctive terms beat full sentences.'),
        queries: z.array(z.string()).optional().describe('Alternative phrasings of the same question, searched together with query and fused by rank. Use synonyms, the other language and the concrete product name; 2-4 is plenty.'),
        domain: z.string().optional().describe('Only neurons in this domain (exact match, e.g. "proyectos-web").'),
        limit: z.number().optional().describe('Max neurons returned (default 10).'),
      },
      outputSchema: {
        query: z.string(),
        total_results: z.number(),
        results: z.array(z.object({
          neuron_id: z.string(), name: z.string(), domain: z.string(),
          relevance_score: z.number(), matching_content: z.string(),
          matched_kind: z.string().optional(), matched_added: z.string().optional(),
          heat: z.number(), has_map: z.boolean().optional(),
          matched_terms: z.number().optional(), query_terms: z.number().optional(),
          confidence: z.enum(['strong', 'weak']).optional(),
          also_matched: z.array(z.object({ text: z.string(), kind: z.string(), added: z.string() })).optional(),
        }).loose()),
        hint: z.string(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {        const results = await searchEngine.searchMany([args.query, ...(args.queries || [])], {
          domain: args.domain,
          limit: args.limit,
        });

        const payload = {
          query: args.query,
          total_results: results.length,
          results,
          hint: results.length === 0
            ? 'Nothing matched. Try fewer, more distinctive words - names, ids, filenames - rather than a full sentence.'
            : 'matching_content is the chunk that matched; matched_added is when it was recorded; confidence "weak" means little of the question was covered - verify before relying on it. Prefer recent facts when two disagree. has_map: true means the neuron holds a system map - read it with crbro_map before working on that system.',
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `CRBRO recall error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 7: crbro_connect — Create/strengthen a synapse
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_connect',
    {
      title: 'Connect two neurons',
      description: 'Create or strengthen the undirected synapse between two neurons: created at strength 0.5, +0.1 per repeat call (cap 1.0). Idle synapses decay and crbro_maintenance prunes the weak. Returns synapse_id, action (created|strengthened) and strength. Neurons written in the same session are linked automatically by crbro_consolidate; use this for relationships that are not just co-occurrence.',
      inputSchema: {
        from: z.string().describe('Source neuron id, e.g. "project_octochat". Not validated: use an exact id from crbro_recall or crbro_neurons, or the synapse points at nothing.'),
        to: z.string().describe('Target neuron id. Order does not matter — (a,b) and (b,a) are the same synapse.'),
        type: z.enum(['dependency', 'causal', 'temporal', 'conceptual', 'hierarchy', 'alternative']).describe('Relationship kind. Used only on creation; a strengthening call keeps the existing type.'),
        context: z.string().optional().describe('One line on the relationship. On strengthen it replaces the stored text; omit to keep it.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {        const result = await synapses.connect(args.from, args.to, args.type, args.context);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              synapse_id: result.synapse.id,
              action: result.action,
              strength: result.synapse.strength,
              message: result.action === 'created'
                ? `New synapse: ${args.from} ↔ ${args.to} (${args.type})`
                : `Synapse strengthened: ${args.from} ↔ ${args.to} → strength ${result.synapse.strength}`,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `CRBRO connect error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 8: crbro_connections — Get neuron connections
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_connections',
    {
      title: 'Neuron connections',
      description: 'List every synapse touching one neuron, strongest first — target_id, target_name, type, strength and context per entry. Read-only; an unknown or unconnected id returns an empty list, not an error.',
      inputSchema: {
        neuron_id: z.string().describe('Exact neuron id, e.g. "project_octochat". Names are not resolved here — get the id from crbro_recall or crbro_neurons.'),
        min_strength: z.number().optional().describe('Drop connections weaker than this (0.0-1.0). Omit for all; 0 is no filter.'),
      },
      outputSchema: {
        neuron_id: z.string(),
        total_connections: z.number(),
        connections: z.array(z.object({
          target_id: z.string(), target_name: z.string(), type: z.string(),
          strength: z.number(), context: z.string(),
        }).loose()),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {        const connections = await synapses.getConnections(args.neuron_id, args.min_strength);

        const payload = { neuron_id: args.neuron_id, total_connections: connections.length, connections };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `CRBRO connections error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 9: crbro_session_log — Log a session
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_session_log',
    {
      title: 'Log a session',
      description: 'Log a session summary to the hippocampus — one entry per calendar day; a same-day call appends to it. Also replaces the active-topics list with topics_touched. Normally unnecessary: crbro_consolidate logs the session itself.',
      inputSchema: {
        summary: z.string().describe('What happened in this session. Appended if today already has an entry.'),
        topics_touched: z.array(z.string()).describe('Relevant neuron ids. Merged (deduplicated) into the day entry; becomes the active-topics list.'),
        key_facts_added: z.number().optional().describe('New facts stored. Summed into the day total on same-day calls.'),
        decisions_made: z.number().optional().describe('Decisions recorded. Summed into the day total on same-day calls.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {        const session = await hippocampus.logSession({
          summary: args.summary,
          topics_touched: args.topics_touched,
          key_facts_added: args.key_facts_added,
          decisions_made: args.decisions_made,
        });

        // Update active context with last session
        await prefrontal.updateContext({
          set_topics: args.topics_touched,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              session_id: session.session_id,
              date: session.date,
              message: 'Session logged to hippocampus.',
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `CRBRO session_log error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 10: crbro_sessions — List recent sessions
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_sessions',
    {
      title: 'Recent sessions',
      description: 'List recent session logs, newest first, one per day: date, merged summary, topics_touched neuron ids, fact/decision counters. Read-only. Read them before asking the user what was already done; crbro_boot already returns the last one.',
      inputSchema: {
        limit: z.number().optional().describe('Day logs to return, newest first (default 10).'),
      },
      outputSchema: {
        total: z.number(),
        sessions: z.array(z.object({
          session_id: z.string().optional(), date: z.string().optional(), summary: z.string().optional(),
          topics_touched: z.array(z.string()).optional(),
          key_facts_added: z.number().optional(), decisions_made: z.number().optional(),
        }).loose()),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {        const sessions = await hippocampus.listSessions(args.limit);

        const payload = { total: sessions.length, sessions };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `CRBRO sessions error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 11: crbro_context — Active context
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_context',
    {
      title: 'Working context',
      description: 'Read or update the working context: active topics, open items, last session. Call with no arguments to read; every call returns the full state plus resolved, the items it closed. Close items as soon as they are done — an item left open is repeated back to the user in later sessions long after it was finished.',
      inputSchema: {
        set_topics: z.array(z.string()).optional().describe('Replace the whole active-topics list with these neuron ids (no merge). crbro_session_log also overwrites it.'),
        add_pending: z.string().optional().describe('Add an open item, written so it can be checked later. Identical text is deduplicated, so re-adding is a safe no-op.'),
        resolve_pending: z.string().optional().describe('Close an open item by id (e.g. "p_ab12cd") or by 8+ characters of its text (case-insensitive substring; several items can close at once). Matches move to recently_closed, newest first, capped at 15. An empty resolved in the reply means nothing matched.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {        const ctx = await prefrontal.updateContext({
          set_topics: args.set_topics,
          add_pending: args.add_pending,
          resolve_pending: args.resolve_pending,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(ctx, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `CRBRO context error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 12: crbro_hot_topics — Hot topics
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_hot_topics',
    {
      title: 'Hot topics',
      description: 'The hottest neurons by heat (access frequency, recency, connectivity). Read-only, served from a cache rebuilt at consolidate and maintenance — last_recalculated says when. crbro_boot already returns this list.',
      inputSchema: {
        limit: z.number().optional().describe('Topics to return (default 15; the cache never holds more than 20).'),
      },
      outputSchema: {
        topics: z.array(z.object({
          id: z.string(), name: z.string(), heat: z.number(), last_access: z.string(), domain: z.string(),
        }).loose()),
        last_recalculated: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {        const hotTopics = await prefrontal.getHotTopics(args.limit);

        const payload = { ...hotTopics };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `CRBRO hot_topics error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 13: crbro_global_map — Global neural map
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_global_map',
    {
      title: 'Global map',
      description: 'The global map: one cluster per domain (node ids, top neurons, heat) and bridges where synapses cross domains, served from a cache stamped last_rebuilt. Read-only unless rebuild:true, which rescans every neuron and rewrites that cache (derived data, no knowledge is touched). For one system\'s internals use crbro_map instead.',
      inputSchema: {
        rebuild: z.boolean().optional().describe('true = rescan every neuron and rewrite the cached map (slower on big brains). Default: serve the cache, building it only if missing — it can lag recent learning; crbro_maintenance also rebuilds it.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const globalMap = await prefrontal.getGlobalMap(args.rebuild);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              total_clusters: globalMap.clusters.length,
              total_bridges: globalMap.bridges.length,
              last_rebuilt: globalMap.last_rebuilt,
              clusters: globalMap.clusters,
              bridges: globalMap.bridges,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `CRBRO global_map error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 14: crbro_maintenance — Run maintenance
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_maintenance',
    {
      title: 'Brain maintenance',
      description: 'Run brain maintenance: recalculate heat, prune weak synapses, check integrity and rebuild the search index. Returns a report (counts, integrity_issues, notes) and flags debts that never named a revisit trigger. dry_run:true reports without writing anything. Archiving cold neurons and purging miner boilerplate are OFF unless asked — on a mature brain most neurons look cold, and archived ones stop being searchable. For session close use crbro_consolidate, not this.',
      inputSchema: {
        dry_run: z.boolean().optional().describe('true = report only: no heat recalc, archiving, purge, lock sweep, pruning or index rebuild. Counts, debts and integrity checks still run.'),
        archive: z.boolean().optional().describe('Also move cold neurons (heat < 0.05, untouched 90+ days) out of the cortex. Off by default; run dry_run first and read archivable_neurons. Restore by moving the file from archives/ back into cortex/.'),
        purge_boilerplate: z.boolean().optional().describe('Also delete contentless facts left by early miner versions ("Referenced in: file.md"). Off by default; every run reports how many there are. Neurons left empty are kept.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const report = await maintenance.run(args.dry_run, { archive: args.archive, purgeBoilerplate: args.purge_boilerplate });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              mode: args.dry_run ? 'DRY RUN' : 'EXECUTED',
              ...report,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `CRBRO maintenance error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 15: crbro_consolidate — End-of-session consolidation
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_consolidate',
    {
      title: 'Consolidate the session',
      description: 'Call before the conversation ends whenever significant work was done. Persists pending knowledge and index writes, logs the session from summary (no separate crbro_session_log needed), recalculates heat, links the neurons written this session with weak temporal synapses (synapses_updated), updates the manifest and syncs shared team spaces (offline is normal; notes go out next time). Returns the session\'s real write counts — facts_saved, decisions_saved, topics_touched — and per-space sync state. Not consolidating loses the session\'s knowledge.',
      inputSchema: {
        summary: z.string().describe('What was accomplished: concrete work, decisions, outcomes. Stored verbatim as the session log later sessions read.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {        const result = await maintenance.consolidate(args.summary);
        // Flush any index writes still sitting in the debounce window, so a
        // session that ends right after a learn does not lose it.
        await searchEngine.flush();
        // Send the session's notes to the team before the lights go out.
        const compartidos = await syncAll(brain, cortex, 10_000);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ...result,
              shared_spaces: compartidos.length > 0
                ? compartidos.map(c => ({ space: c.space, state: c.state, pushed: c.pushed }))
                : undefined,
              message: 'Session consolidated. Brain state persisted.',
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `CRBRO consolidate error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL: crbro_map — The living map of a system
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_map',
    {
      title: 'System map',
      description: 'Read or replace a neuron\'s system map: ONE living document — where the system lives, what serves what, which pieces talk to each other, the traps that cost hours. Read it before working on a system touched in past sessions; after changing the system, rewrite the whole map — content replaces the previous version entirely (append-only maps rot). Omit content to read (map:null if none yet); an empty string clears it. Reading never creates a neuron, writing does. Credentials are redacted on write and listed in redacted. Atomic facts belong in crbro_learn — the map is the prose reference around them.',
      inputSchema: {
        neuron: z.string().describe('Neuron id or name, e.g. "project_octochat" or "OctoChat".'),
        content: z.string().optional().describe('The new map, replacing the old one whole; omit to read. Write the reference you will need next time: paths, ids, what-serves-what, gotchas. An empty string clears the map.'),
        domain: z.string().optional().describe('Domain if the neuron has to be created, e.g. "proyectos-web". Ignored when it exists.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        if (args.content === undefined) {
          const neuron =
            (await cortex.peek(args.neuron)) || (await cortex.findByName(args.neuron));
          if (!neuron) {
            return {
              content: [{
                type: 'text' as const,
                text: `Neuron not found: "${args.neuron}". Use crbro_recall to find the right neuron_id first.`,
              }],
            };
          }
          if (!neuron.map || !neuron.map.text) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  neuron_id: neuron.id,
                  map: null,
                  message: `"${neuron.name}" has no system map yet. After working on this system, write one with crbro_map + content: where it lives, what serves what, the traps.`,
                }, null, 2),
              }],
            };
          }
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                neuron_id: neuron.id,
                updated: neuron.map.updated,
                by: neuron.map.by,
                map: neuron.map.text,
                hint: 'If anything here proved wrong or the system changed, rewrite the map before closing the task.',
              }, null, 2),
            }],
          };
        }

        const result = await cortex.setMap(args.neuron, args.content, {
          domain: args.domain,
        });
        if (!result.neuron) {
          return {
            content: [{
              type: 'text' as const,
              text: `Could not store the map for "${args.neuron}".`,
            }],
          };
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              neuron_id: result.neuron.id,
              action: result.action,
              updated: result.neuron.map?.updated,
              length: args.content.length,
              redacted: result.redacted.length > 0 ? result.redacted : undefined,
              message: args.content.trim() === ''
                ? `System map of "${result.neuron.name}" cleared.`
                : `System map of "${result.neuron.name}" replaced. The previous version is gone - this one is now the reference.`,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `CRBRO map error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 16: crbro_revise — Retire knowledge that stopped being true
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_revise',
    {
      title: 'Revise facts',
      description: 'Mark stored facts as no longer current — the moment you find something saved is out of date or was wrong, since a memory that only appends keeps serving the old version with equal confidence. Superseded facts leave crbro_recall but stay in the neuron file, so the correction is auditable. Matches by fact id or exact text; anything reported in unmatched is STILL LIVE — fix and re-run. If a replacement fact exists, crbro_learn with supersedes does both in one call. To delete outright, use crbro_forget.',
      inputSchema: {
        neuron: z.string().describe('Neuron id or name holding the facts, e.g. "project_octochat".'),
        facts: z.array(z.string()).describe('Facts to retire: their ids (from crbro_recall) or exact text (trimmed, case-insensitive). Already-retired facts never match.'),
        status: z.enum(['superseded', 'retracted']).optional().describe('superseded = there is a newer truth (default); retracted = it was never true.'),
        note: z.string().optional().describe('Why it stopped being true. The next reader will wonder.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = await cortex.revise(args.neuron, args.facts, {
          status: args.status,
          note: args.note,
        });

        if (!result.neuron) {
          return {
            content: [{
              type: 'text' as const,
              text: `Neuron not found: "${args.neuron}". Use crbro_recall to find the right neuron_id first.`,
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              neuron_id: result.neuron.id,
              revised: result.revised,
              status: args.status || 'superseded',
              unmatched: result.unmatched.length > 0 ? result.unmatched : undefined,
              message: result.revised > 0
                ? `${result.revised} fact(s) retired in "${result.neuron.name}". They no longer appear in recall.` +
                  (result.unmatched.length > 0
                    ? ` WARNING: ${result.unmatched.length} target(s) matched nothing and are still live.`
                    : '')
                : 'Nothing matched. Pass the fact id from crbro_recall, or its exact text.',
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `CRBRO revise error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 17: crbro_audit — What should not be in the brain
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_audit',
    {
      title: 'Audit for credentials',
      description: 'Read-only scan of every field of every neuron (facts, decisions, patterns, preferences, errors, debts, system map) for credentials stored before the filter caught them — API keys, tokens, passwords. Reports where they sit and what kind, never the values. Findings are in the search index too, so recall can return them: remove with crbro_forget, then rotate the credential. Run it after upgrading and whenever a secret may have been pasted into a conversation.',
      inputSchema: {},
      outputSchema: {
        neurons_affected: z.number(),
        facts_affected: z.number(),
        findings: z.array(z.object({
          neuron_id: z.string(), name: z.string(), kinds: z.array(z.string()),
          facts: z.number(), decisions: z.number(), patterns: z.number(), preferences: z.number(),
          errors: z.number(), debts: z.number(), map: z.number(),
        }).loose()),
        message: z.string(),
        note: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const hallazgos = await cortex.auditSecrets();
        const total = hallazgos.reduce(
          (n, h) => n + h.facts + h.decisions + h.patterns + h.preferences + h.errors + h.debts + h.map, 0);

        const payload = {
          neurons_affected: hallazgos.length,
          facts_affected: total,
          findings: hallazgos,
          message: hallazgos.length === 0
            ? 'No credentials found in the brain.'
            : `${total} entr(y/ies) across ${hallazgos.length} neuron(s) contain something that looks like a credential. ` +
              'They are also inside the search index, so recall can return them. ' +
              'Remove them with crbro_forget, then rotate the credentials — assume they are compromised.',
          note: 'Values are never shown here, by design.',
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `CRBRO audit error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 22: crbro_secret — Credentials, brokered to the OS keychain
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_secret',
    {
      title: 'Keychain secret',
      description: 'Credentials, brokered to the operating system\'s own keychain (macOS Keychain, Linux Secret Service, Windows DPAPI): CRBRO keeps no copy and invents no crypto, and no sync or team space can reach the store. The moment the user hands you a credential: set it here, then record only the NAME with crbro_learn. get returns the value for the task at hand — an environment variable of the same name wins, a missing secret returns found:false, not an error — and it must not be printed back unless the user asked for that secret. list returns names only; remove deletes one; status says which store this machine has. Names are SCREAMING_SNAKE_CASE; set updates an existing name in place and rejects empty values. A machine with no store is a normal status answer, not a failure — environment variables still work.',
      inputSchema: {
        action: z.enum(['get', 'set', 'list', 'remove', 'status'])
          .describe('get = read one, set = store or update one, list = names only, remove = delete one, status = which keychain this machine offers, or why none.'),
        name: z.string().optional().describe('SCREAMING_SNAKE_CASE, e.g. WORDPRESS_APP_PASSWORD. Required for get, set and remove.'),
        value: z.string().optional().describe('The credential itself, non-empty. Only for set.'),
        description: z.string().optional().describe('What it is for, e.g. "WordPress example.com - REST API". Only for set.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        let payload: Record<string, unknown>;

        if (args.action === 'status') {
          const { backend, reason } = detectBackend();
          payload = {
            backend,
            available: backend !== null,
            message: backend
              ? `Credentials on this machine are stored in: ${backend}.`
              : `No credential store available here. ${reason ?? ''} Credentials can still be passed as environment variables.`,
          };

        } else if (args.action === 'list') {
          const entries = listSecrets();
          payload = {
            count: entries.length,
            secrets: entries,
            note: 'Names only. Values are never listed, by design.',
          };

        } else if (!args.name) {
          throw new Error(`"name" is required for action "${args.action}".`);

        } else if (args.action === 'set') {
          if (!args.value) throw new Error('"value" is required for action "set".');
          setSecret(args.name, args.value, args.description ?? '');
          payload = {
            stored: args.name,
            message: `Stored in the OS keychain as ${args.name}. Now record the NAME in the brain with crbro_learn — never the value — so a later session knows where to look.`,
          };

        } else if (args.action === 'remove') {
          const gone = removeSecret(args.name);
          payload = {
            removed: gone,
            message: gone
              ? `${args.name} deleted from the keychain.`
              : `No secret named ${args.name} was found.`,
          };

        } else {
          const value = getSecret(args.name);
          payload = value === null
            ? {
                found: false,
                message: `No secret named ${args.name}. Run action "list" to see what is stored, or ask the user for it and store it with action "set".`,
              }
            : {
                found: true,
                name: args.name,
                value,
                note: 'Use it for the task at hand. Do not repeat it back to the user and do not write it into any file.',
              };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(payload, null, 2),
          }],
        };

      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: err instanceof KeychainUnavailable
              ? `No credential store available: ${err.message}`
              : `CRBRO secret error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 18: crbro_forget — Remove knowledge for good
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_forget',
    {
      title: 'Forget for good',
      description: 'Permanently remove entries from a neuron — for what must not exist at all: a credential, personal data, something stored by mistake. Matches facts, decisions, patterns, preferences, errors and debts by id or exact text (trimmed, case-insensitive), and the system map by its exact full text. Destructive, with a net: the whole neuron is copied to .quarantine/ first (backup path returned) and the search index is updated; nothing matched returns removed:0, not an error. On shared neurons the removal travels. For knowledge that merely stopped being true use crbro_revise, which keeps the history. Tell the user what will be removed and get their agreement first; a removed credential must still be rotated — it existed on disk and in the index.',
      inputSchema: {
        neuron: z.string().describe('Neuron id or name holding the entries.'),
        facts: z.array(z.string()).describe('Fact ids, or the exact text of a fact, decision, pattern, preference, error or debt. The exact full text of the map removes the map.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const r = await cortex.forget(args.neuron, args.facts);

        if (!r.neuron_id) {
          return {
            content: [{
              type: 'text' as const,
              text: `Neuron not found: "${args.neuron}". Use crbro_recall or crbro_audit to find the right one.`,
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              neuron_id: r.neuron_id,
              removed: r.removed,
              backup: r.backup,
              message: r.removed > 0
                ? `${r.removed} fact(s) removed from "${r.neuron_id}". A copy of the neuron as it was is in ${r.backup}. ` +
                  'If any of them was a credential, rotate it: it existed on disk and in the index.'
                : 'Nothing matched. Pass the fact id from crbro_recall, or its exact text.',
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `CRBRO forget error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 19: crbro_space — Join a team's shared memory
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_space',
    {
      title: 'Team space',
      description: 'Shared memory with teammates. A space is a private git repository holding notes about the projects you choose to share — nothing else from your brain goes near it. One person runs create with the repository URL; everyone else runs join with the same URL; afterwards it syncs by itself at boot and consolidate. Joining shares nothing by itself: put each project in with crbro_share. status lists your identity and spaces. create and join need name, remote and author, and reply ok:false with the reason when git is missing or the push/clone fails.',
      inputSchema: {
        action: z.enum(['create', 'join', 'status']).describe('create = start a new space and push it, join = clone one a teammate created, status = your identity and the spaces you are in.'),
        name: z.string().optional().describe('Short name, e.g. "equipo" — the same on everyone\'s machine. Required for create and join.'),
        remote: z.string().optional().describe('Git URL of a private repository — EMPTY for create, the same URL the creator used for join. E.g. git@github.com:acme/team-memory.git.'),
        author: z.string().optional().describe('How your notes are signed, e.g. "ana". Lowercase, no spaces. Required for create and join.'),
        branch: z.string().optional().describe('Branch to use (default "main").'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        if (args.action === 'status') {
          const nombres = await listSpaces(brain);
          const id = await getIdentity(brain);
          const detalle = [];
          for (const n of nombres) {
            const cfg = await readSpace(brain, n);
            if (cfg) detalle.push({ name: cfg.name, created_by: cfg.created_by, branch: cfg.branch });
          }
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                you_are: id.author,
                device: id.device,
                spaces: detalle,
                message: detalle.length === 0
                  ? 'You are not in any shared space. Use action "create" to start one, or "join" if a teammate already did.'
                  : `In ${detalle.length} space(s). They sync automatically at boot and on consolidate.`,
              }, null, 2),
            }],
          };
        }

        if (!args.name || !args.remote) {
          return {
            content: [{ type: 'text' as const, text: 'Both name and remote are required for create and join.' }],
          };
        }
        if (!args.author) {
          return {
            content: [{ type: 'text' as const, text: 'Pass author so your notes carry your name, e.g. author: "ana".' }],
          };
        }

        const r = args.action === 'create'
          ? await createSpace(brain, args.name, args.remote, args.author, args.branch || 'main')
          : await joinSpace(brain, args.name, args.remote, args.author, args.branch || 'main');

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: r.ok,
              message: r.message,
              detail: r.detail,
              next: r.ok && args.action === 'create'
                ? 'Now share a project into it with crbro_share, and invite your teammates to the repository.'
                : r.ok
                ? 'Run crbro_sync to pull in what the others already know.'
                : undefined,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `CRBRO space error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 20: crbro_share — Put one project into a space
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_share',
    {
      title: 'Share a project',
      description: 'Share one neuron with a team space. Always call it without confirm first: the dry run reports exactly what would be sent — ops_to_emit, skipped_preferences (preferences never leave this machine) — and refuses outright if it finds a credential (it will not redact and send anyway: crbro_forget it and rotate it). Show the user that report and get their agreement, then call again with the confirm_token; a stale token is refused. Entries go out on the next crbro_sync or consolidate, and from then on everything learned about that project flows to the team. Sharing cannot be undone.',
      inputSchema: {
        neuron: z.string().describe('Neuron id or name to share.'),
        space: z.string().describe('Space name, as created or joined with crbro_space.'),
        confirm: z.string().optional().describe('The confirm_token from the dry run — returned only when no credential was found. Omit the first time.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        if (!args.confirm) {
          const prep = await prepareShare(brain, cortex, args.neuron, args.space);
          if ('error' in prep) {
            return { content: [{ type: 'text' as const, text: prep.error }] };
          }
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                ...prep,
                message: prep.blocked.length > 0
                  ? `Refused: ${prep.blocked.length} credential(s) found in this neuron. Nothing was sent. ` +
                    'Remove them with crbro_forget and rotate them, then try again.'
                  : `Ready to share ${prep.ops_to_emit} entries. ${prep.skipped_preferences} preference(s) will NOT be sent — ` +
                    'preferences never leave this machine. Show the user what is about to be shared, then call again with the confirm token.',
              }, null, 2),
            }],
          };
        }

        const r = await commitShare(brain, cortex, args.neuron, args.space, args.confirm);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ...r,
              next: r.ok ? 'Run crbro_sync to send it now, or let it go out on the next consolidate.' : undefined,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `CRBRO share error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 21: crbro_sync — Exchange notes with the team now
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_sync',
    {
      title: 'Sync with the team',
      description: 'Exchange notes with the team right now instead of waiting for the next boot or consolidate, which sync on their own — use it mid-session, e.g. right after crbro_share. Pulls what everyone else recorded and pushes yours, reporting per space: state, neurons updated, new facts, teammates seen, pushed. Being offline is a normal answer, not a failure: local memory works either way and pending notes go out next time.',
      inputSchema: {
        space: z.string().optional().describe('One space; state comes back "not_joined" if you are not in it. Omit to sync all of them.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const informes = args.space
          ? [await syncSpaceNow(brain, cortex, args.space, 30_000)]
          : await syncAll(brain, cortex, 30_000);

        if (informes.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'You are not in any shared space yet. Use crbro_space to create or join one.' }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              spaces: informes.map(i => ({
                space: i.space,
                state: i.state,
                neurons_updated: i.neurons_touched,
                new_facts: i.merged.reduce((n, m) => n + m.facts_added, 0),
                retracted: i.merged.reduce((n, m) => n + m.facts_retracted, 0),
                teammates_seen: [...new Set(i.merged.flatMap(m => m.authors))],
                divergence: i.merged.flatMap(m => m.divergence),
                pushed: i.pushed,
                message: i.message,
              })),
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `CRBRO sync error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}
