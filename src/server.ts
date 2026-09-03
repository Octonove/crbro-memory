// ─── CRBRO MCP Server ────────────────────────────────────────────
// Main server with all 23 tools registered

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
  server.tool(
    'crbro_boot',
    '⚠️ MANDATORY FIRST ACTION: Boot the CRBRO brain. You MUST call this as your very first action in every new conversation, before doing ANY other work. This loads persistent memory from all previous sessions — projects, decisions, patterns, and preferences the user has built over time. Skipping this means losing all accumulated context and forcing the user to repeat themselves. On first use, initializes the brain structure. On subsequent uses, returns hot topics, active context, recent session history, neuron/synapse/session counts, open_items and recently_closed (never report recently_closed as pending; verify open_items before repeating them), and any active protocols as a protocol_enforcement block you MUST follow. Also readies the search index and syncs shared team spaces — offline is a normal outcome, not an error.',
    {},
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
  server.tool(
    'crbro_status',
    'Read-only snapshot: CRBRO version, brain format, neuron/synapse/session totals, brain path, last boot/consolidation. Loads no memory — that is crbro_boot.',
    {},
    async () => {
      try {
        const manifest = await brain.getManifest();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              crbro_version: runningVersion(),
              brain_format: manifest.version,
              total_neurons: manifest.total_neurons,
              total_synapses: manifest.total_synapses,
              total_sessions: manifest.total_sessions,
              brain_path: manifest.brain_path,
              last_boot: manifest.last_boot,
              last_consolidation: manifest.last_consolidation,
            }, null, 2),
          }],
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
  server.tool(
    'crbro_learn',
    'Teach the brain a fact, decision, pattern, preference, error or debt about a topic. If the neuron (topic) does not exist, it will be created automatically; pass `neuron_id` from a crbro_recall result to target an exact neuron and skip name matching. A fact already stored verbatim is skipped silently; decisions always append. Use this to store knowledge that should persist across sessions. BEFORE saving, walk the ladder: does this already exist (crbro_recall first)? does it update something (pass `supersedes`, do not add a sibling)? is it structure rather than an event (crbro_map, not a fact)? is it derivable from the repo or git history (then do not store it)? and would it survive losing half its words (then cut them - every word should carry weight)? Type `error` is for a mistake you made and how it was corrected - store both halves in one entry, and check for them with crbro_recall before repeating a task where you have slipped before. Type `debt` is the twin for deliberate deferrals - what was skipped on purpose, its ceiling, and when to revisit; before re-proposing or re-discussing something, recall may surface that it was already deferred with a reason. Type `preference` never leaves this machine - it is excluded from sharing and sync. Anything that looks like a credential is replaced with a marker before it reaches disk (the sentence around it is kept) and reported in `redacted` - store the value with crbro_secret and record only its name. Returns neuron_id, action (created/updated), superseded count and running totals. If the new fact closely resembles an active one, the response warns with `near_duplicates` - it is stored anyway, but retire the old telling or two versions keep coming back on recall as equals. A `supersedes` target matching no active fact is reported in `supersedes_unmatched` - the old version is still live; retire it with crbro_revise.',
    {
      topic: z.string().describe('The topic name (e.g., "OctoChat", "Firebase", "SEO Strategy")'),
      type: z.enum(['fact', 'decision', 'pattern', 'preference', 'error', 'debt']).describe('Type of knowledge to store. `error` = a mistake plus its correction, kept as a ledger you can check before repeating the task. `debt` = a deliberate deferral: what was NOT done on purpose, its ceiling, and the condition to revisit — write all three in one entry, e.g. "DEFERRED: protecting the PDFs. CEILING: anyone can download the lead magnets without signing up. REVISIT WHEN: the signup flow works." When someone re-proposes a dead idea, recall serves the decision with its date and trigger.'),
      content: z.string().describe('The knowledge content to remember. Write it dense and self-contained - it will be recalled without this conversation as context. Credential-like values are redacted to a marker before touching disk.'),
      confidence: z.number().min(0).max(1).optional().describe('Confidence level 0.0-1.0 (default 1.0)'),
      domain: z.string().optional().describe('Domain category (e.g., "proyectos-web", "infraestructura"). Applied when the neuron is created; on an existing neuron it only replaces the default "general".'),
      rationale: z.string().optional().describe('Why the decision was taken. Stored and indexed with the decision text; ignored for other types.'),
      neuron_id: z.string().optional().describe('Exact neuron ID to write to (e.g. "project_octochat"). Pass the neuron_id you got back from crbro_recall: it skips name matching entirely and guarantees the knowledge lands where you mean.'),
      supersedes: z.array(z.string()).optional().describe('Facts this one replaces: their ids, or their exact text. They stop showing up in recall but stay in the neuron file. A target matching no active fact comes back in supersedes_unmatched and stays live.'),
    },
    async (args) => {
      try {        const result = await cortex.learn(args.topic, args.type, args.content, {
          confidence: args.confidence,
          domain: args.domain,
          rationale: args.rationale,
          neuronId: args.neuron_id,
          supersedes: args.supersedes,
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
  server.tool(
    'crbro_neuron',
    'Read a specific neuron by ID or name. Returns its facts (newest first; superseded and retracted hidden unless include_superseded), decisions, patterns, preferences, errors, debts, connections, heat and system map. Reading bumps access stats. Big neurons are paginated - page through them with offset instead of trying to pull everything at once.',
    {
      id: z.string().describe('Neuron ID (e.g., "project_octochat") or name (e.g., "OctoChat")'),
      limit: z.number().optional().describe('How many facts to return (default 40, max 200)'),
      offset: z.number().optional().describe('Skip this many facts. Facts come newest first.'),
      include_superseded: z.boolean().optional().describe('Include facts marked superseded or retracted (default false)'),
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
  server.tool(
    'crbro_neurons',
    'List neurons, hottest first, filtered by domain/type/min_heat. Each row: id, name, domain, type, heat, last_accessed, facts_count. To search content, use crbro_recall.',
    {
      domain: z.string().optional().describe('Filter by domain (e.g., "proyectos-web")'),
      type: z.enum(['project', 'tech', 'lang', 'person', 'domain', 'process', 'protocol']).optional().describe('Filter by neuron type'),
      min_heat: z.number().optional().describe('Minimum heat score (0.0-1.0). Heat blends access frequency, recency and connectivity; recently touched neurons run hot.'),
      limit: z.number().optional().describe('Max results (default 50)'),
    },
    async (args) => {
      try {        const neurons = await cortex.list({
          domain: args.domain,
          type: args.type,
          min_heat: args.min_heat,
          limit: args.limit,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              total: neurons.length,
              neurons,
            }, null, 2),
          }],
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
  server.tool(
    'crbro_recall',
    'Search the brain for knowledge saved in earlier sessions. Searches the full text of every fact, decision, pattern, preference, error, debt and system map, not just topic names, and each result carries the exact chunk that matched (matching_content, matched_kind) plus the date it was recorded (matched_added). One result per neuron, its best chunk; superseded and retracted facts never surface. Call this before asking the user something they may already have told you, and before assuming a past decision - and before crbro_learn, to catch what already exists. When results disagree, prefer the more recent. If nothing matches, retry with fewer, more distinctive words - names, ids, filenames - rather than a full sentence. A result with has_map: true belongs to a neuron that keeps a system map - read it with crbro_map before touching that system. If a result looks right, pass its neuron_id back to crbro_learn so new knowledge lands in the same place.',
    {
      query: z.string().describe('What to search for (e.g., "Firebase authentication setup"). Fewer, distinctive terms - names, ids, filenames - beat full sentences.'),
      domain: z.string().optional().describe('Only return results whose neuron is in this domain (exact match, e.g. "proyectos-web")'),
      limit: z.number().optional().describe('Max neurons returned (default 10) - each result is one neuron with its best-matching chunk.'),
    },
    async (args) => {
      try {        const results = await searchEngine.search(args.query, {
          domain: args.domain,
          limit: args.limit,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              query: args.query,
              total_results: results.length,
              results,
              hint: results.length === 0
                ? 'Nothing matched. Try fewer, more distinctive words - names, ids, filenames - rather than a full sentence.'
                : 'matching_content is the chunk that matched; matched_added is when it was recorded. Prefer recent facts when two disagree. Results with has_map: true belong to neurons holding a system map - read it with crbro_map before working on that system.',
            }, null, 2),
          }],
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
  server.tool(
    'crbro_connect',
    'Create or strengthen the undirected synapse between two neurons — created at strength 0.5, +0.1 per repeat call (cap 1.0). Idle synapses decay and crbro_maintenance prunes the weak. Returns synapse_id, action (created|strengthened) and strength.',
    {
      from: z.string().describe('Source neuron ID (e.g. "project_octochat"). Not validated: use an exact id from crbro_recall or crbro_neurons, or the synapse points at nothing.'),
      to: z.string().describe('Target neuron ID. Order does not matter — (a,b) and (b,a) address the same synapse.'),
      type: z.enum(['dependency', 'causal', 'temporal', 'conceptual', 'hierarchy', 'alternative']).describe('Relationship kind. Used only when the synapse is created — a strengthening call keeps the existing type.'),
      context: z.string().optional().describe('One-line description of the relationship. On strengthen it replaces the stored text; omit to keep it.'),
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
  server.tool(
    'crbro_connections',
    'List every synapse touching one neuron, strongest first — target_id, target_name, type, strength and context per entry. Unknown or unconnected ids return an empty list, not an error.',
    {
      neuron_id: z.string().describe('Exact neuron ID (e.g. "project_octochat"). Names are not resolved here — get the id from crbro_recall or crbro_neurons.'),
      min_strength: z.number().optional().describe('Drop connections weaker than this (0.0-1.0). Omit for all; 0 acts as no filter.'),
    },
    async (args) => {
      try {        const connections = await synapses.getConnections(args.neuron_id, args.min_strength);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              neuron_id: args.neuron_id,
              total_connections: connections.length,
              connections,
            }, null, 2),
          }],
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
  server.tool(
    'crbro_session_log',
    'Log a session summary to the hippocampus — one entry per calendar day; a same-day call appends to it. Call at the end of a work session to record what was done (crbro_consolidate logs one itself). Also replaces the active topics with topics_touched.',
    {
      summary: z.string().describe('Summary of what happened in this session. If today already has an entry, this text is appended to it.'),
      topics_touched: z.array(z.string()).describe('Neuron IDs that were relevant. Merged (deduplicated) into the day entry; becomes the new active-topics list.'),
      key_facts_added: z.number().optional().describe('Number of new facts stored. Summed into the day total on same-day calls.'),
      decisions_made: z.number().optional().describe('Number of decisions recorded. Summed into the day total on same-day calls.'),
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
  server.tool(
    'crbro_sessions',
    'List recent session logs from the hippocampus, newest first — one per day: date, merged summary, topics_touched neuron ids, fact/decision counters. Read them before asking the user what was already done.',
    {
      limit: z.number().optional().describe('How many day logs to return, newest first (default 10)'),
    },
    async (args) => {
      try {        const sessions = await hippocampus.listSessions(args.limit);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              total: sessions.length,
              sessions,
            }, null, 2),
          }],
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
  server.tool(
    'crbro_context',
    'Read or update the active working context: current topics, open items and last session. Every call returns the full state plus `resolved`, the items it closed; call with no arguments just to read. Close items as soon as they are done - an item left open here gets repeated back to the user in later sessions long after it was finished.',
    {
      set_topics: z.array(z.string()).optional().describe('Replace the whole active-topics list with these neuron IDs (no merge). crbro_session_log also overwrites it.'),
      add_pending: z.string().optional().describe('Add an open item. Write it so it can be checked later, not as a vague reminder. Identical text is deduplicated, so re-adding is a safe no-op.'),
      resolve_pending: z.string().optional().describe('Close an open item: its id (e.g. "p_ab12cd"), or enough of its text to identify it (8+ chars, case-insensitive substring either way — several items can close at once). Matches move to recently_closed, newest first, capped at 15. An empty `resolved` in the reply means nothing matched and the item is still open.'),
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
  server.tool(
    'crbro_hot_topics',
    'Get the hottest topics — neurons with the highest heat scores (based on frequency, recency, and connectivity). Served from a cache rebuilt at consolidate and maintenance — last_recalculated dates it. crbro_boot already returns this list.',
    {
      limit: z.number().optional().describe('Number of topics to return (default 15; the cache never holds more than 20)'),
    },
    async (args) => {
      try {        const hotTopics = await prefrontal.getHotTopics(args.limit);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(hotTopics, null, 2),
          }],
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
  server.tool(
    'crbro_global_map',
    'View the global neural map — one cluster per domain (node ids, top neurons, heat) plus bridges where connections cross domains, served from a cache stamped last_rebuilt. For one system\'s internals use crbro_map instead.',
    {
      rebuild: z.boolean().optional().describe('true = rescan every neuron and rewrite the cached map (slower on big brains). Default: serve the cache, building only if missing — it can lag recent learning; crbro_maintenance also rebuilds it.'),
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
  server.tool(
    'crbro_maintenance',
    'Run brain maintenance: recalculate heat, prune weak synapses, check integrity and rebuild the search index. Returns a report (counts, integrity_issues, notes) and flags debts that never named a revisit trigger. Archiving cold neurons is OFF unless you ask for it - on a mature brain most neurons look cold, and archived ones stop being searchable. For session close use crbro_consolidate, not this.',
    {
      dry_run: z.boolean().optional().describe('If true, report what would happen without acting: no heat recalc, archiving, purge, lock sweep, synapse pruning or index rebuild. Counts, debts and integrity checks still run.'),
      archive: z.boolean().optional().describe('Also move cold neurons (heat < 0.05, untouched 90+ days) out of the cortex. Off by default. Run with dry_run first and read archivable_neurons before turning this on. Restore by moving the file from archives/ back into cortex/.'),
      purge_boilerplate: z.boolean().optional().describe('Also delete contentless facts left by early versions of the miner ("Referenced in: file.md"). Off by default; every run reports how many there are. Neurons left empty are kept - review them with crbro_neurons.'),
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
  server.tool(
    'crbro_consolidate',
    '⚠️ CALL BEFORE SESSION ENDS: Consolidate the brain at end of session. You MUST call this before the conversation ends if ANY significant work was done (code changes, decisions made, new information learned). This persists all new knowledge, logs the session summary, recalculates topic heat scores, and updates the manifest. Also flushes pending index writes and syncs shared team spaces (offline is normal; notes go out next time). Returns this session\'s real write counts (facts_saved, decisions_saved, topics_touched) and per-space sync state. Failing to consolidate means this entire session\'s knowledge is permanently lost. Always provide a meaningful summary of what was accomplished: it doubles as the session log (no separate crbro_session_log needed).',
    {
      summary: z.string().describe('What was accomplished this session: concrete work, decisions, outcomes. Stored verbatim as the session log that later sessions read.'),
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
  server.tool(
    'crbro_map',
    'Read or replace the system map of a neuron. A map is ONE living document answering: where does this system live, what serves what, which pieces talk to each other, and what are the traps that cost hours. Read it BEFORE working on a system you have touched in past sessions - it is the difference between continuing and re-discovering. After building or changing a system, rewrite the whole map so it stays true: pass `content` and it replaces the previous version entirely (append-only maps rot). Without `content` it returns the current map (or map:null if none exists yet). Reading never creates a neuron; writing does, if it is missing. Writing an empty string clears the map. Credentials are redacted on write and listed in `redacted`. Atomic facts belong in crbro_learn - the map is the prose reference around them.',
    {
      neuron: z.string().describe('Neuron ID or name (e.g. "project_octochat" or "OctoChat")'),
      content: z.string().optional().describe('The new map, replacing the old one whole. Omit to read. Write it as the reference you will need next time: paths, ids, what-serves-what, gotchas. An empty string clears the map.'),
      domain: z.string().optional().describe('Domain for the neuron if it has to be created (e.g. "proyectos-web"). Ignored when the neuron already exists.'),
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
  server.tool(
    'crbro_revise',
    'Mark stored facts as no longer current. Use this the moment you discover something you saved is out of date or was wrong: a memory that only ever appends keeps serving the old version alongside the new one, with equal confidence. Superseded facts disappear from crbro_recall but stay in the neuron file, so nothing is lost and the correction is auditable. Matches by fact id or exact text; anything reported in `unmatched` is STILL LIVE - fix and re-run. If a replacement fact exists, crbro_learn with `supersedes` does both in one call. To delete outright, use crbro_forget.',
    {
      neuron: z.string().describe('Neuron ID or name holding the facts (e.g. "project_octochat")'),
      facts: z.array(z.string()).describe('Which facts to retire: their ids (from crbro_recall), or their exact text (matched trimmed, case-insensitive). Already-retired facts never match.'),
      status: z.enum(['superseded', 'retracted']).optional().describe('"superseded" = there is a newer truth (default). "retracted" = it was never true.'),
      note: z.string().optional().describe('Why it stopped being true. Worth writing: the next reader will wonder.'),
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
  server.tool(
    'crbro_audit',
    'Check the brain for credentials that were stored before they could be filtered out — API keys, tokens, passwords. Read-only: scans every field of every neuron (facts, decisions, patterns, preferences, errors, debts, system map) and reports where they sit and what kind, never the values themselves. Findings are also in the search index, so recall can return them: remove with crbro_forget, then rotate the credential. Run it once after upgrading, and any time you suspect a secret was pasted into a conversation.',
    {},
    async () => {
      try {
        const hallazgos = await cortex.auditSecrets();
        const total = hallazgos.reduce(
          (n, h) => n + h.facts + h.decisions + h.patterns + h.preferences, 0);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              neurons_affected: hallazgos.length,
              facts_affected: total,
              findings: hallazgos,
              message: hallazgos.length === 0
                ? 'No credentials found in the brain.'
                : `${total} fact(s) across ${hallazgos.length} neuron(s) contain something that looks like a credential. ` +
                  'They are also inside the search index, so recall can return them. ' +
                  'Remove them with crbro_forget, then rotate the credentials — assume they are compromised.',
              note: 'Values are never shown here, by design.',
            }, null, 2),
          }],
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
  server.tool(
    'crbro_secret',
    'Store and read credentials in the operating system own keychain — macOS Keychain, the Linux Secret Service, or DPAPI on Windows. CRBRO keeps no copy and invents no crypto: it brokers access to the store the machine already has, outside the brain, where no sync and no team space can reach it. Use it the moment the user hands you a credential: store it here, then record only the NAME with crbro_learn, never the value. Use get when a task needs one, and do not print the value back to the user unless they asked for that specific secret. Names are SCREAMING_SNAKE_CASE, e.g. WORDPRESS_APP_PASSWORD; set updates an existing name in place and rejects other spellings and empty values. On get, an environment variable of the same name wins over the store, and a missing secret returns found:false, not an error. list returns names, never values. A machine with no store is a normal status answer, not a failure — credentials can still be passed as environment variables.',
    {
      action: z.enum(['get', 'set', 'list', 'remove', 'status'])
        .describe('get = read one (an environment variable of the same name wins), set = store or update one, list = names only, remove = delete one, status = which keychain this machine offers, or why none'),
      name: z.string().optional().describe('Secret name in SCREAMING_SNAKE_CASE, e.g. WORDPRESS_APP_PASSWORD. Required for get, set and remove.'),
      value: z.string().optional().describe('The credential itself, non-empty. Only for set.'),
      description: z.string().optional().describe('What it is for, e.g. "WordPress example.com - REST API". Only for set.'),
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
  server.tool(
    'crbro_forget',
    'Permanently remove entries from a neuron. This is for things that must not exist at all — a credential, personal data, something stored by mistake. It removes facts, decisions, patterns, preferences, errors and debts matched by id or exact text (trimmed, case-insensitive), and the system map when given its exact full text (or clear the map with crbro_map and empty content). For knowledge that merely stopped being true, use crbro_revise instead, which keeps the history. The whole neuron is copied to .quarantine/ before anything is removed, so a mistake can be undone by hand — the response returns the backup path and the removed count, and the search index is updated so recall stops returning the entries; nothing matched returns removed: 0, not an error. On shared neurons the removal travels: facts retract, errors and debts are purged, a cleared map stays cleared. If a removed entry was a credential, have the user rotate it — it existed on disk and in the index. Always tell the user what you are about to remove and get their agreement first.',
    {
      neuron: z.string().describe('Neuron ID or name holding the entries'),
      facts: z.array(z.string()).describe('What to remove: fact ids, or the exact text of a fact, decision, pattern, preference, error or debt. Passing the exact full text of the map removes it.'),
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
  server.tool(
    'crbro_space',
    'Set up shared memory with teammates. A space is a private git repository holding notes about the projects you choose to share — nothing else from your brain goes near it. One person runs create with the repository URL; everyone else runs join with the same URL. After that it syncs by itself at the start and end of every session. Joining shares nothing by itself: put each project in with crbro_share. create and join need name, remote and author, and reply ok:false with the reason when git is missing or the push or clone fails.',
    {
      action: z.enum(['create', 'join', 'status']).describe('create = start a new space and push it, join = clone one a teammate created, status = your identity and the spaces you are in'),
      name: z.string().optional().describe('Short name for the space, e.g. "equipo". Same on everyone\'s machine. Required for create and join.'),
      remote: z.string().optional().describe('Git URL of a private repository — EMPTY for create, the same URL the creator used for join. E.g. git@github.com:acme/team-memory.git. Required for both.'),
      author: z.string().optional().describe('How your notes are signed, e.g. "ana". Lowercase, no spaces. Required for create and join.'),
      branch: z.string().optional().describe('Branch to use (default "main")'),
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
  server.tool(
    'crbro_share',
    'Share one neuron with a team space. Always run it without a token first: it reports exactly what would be sent — ops_to_emit, skipped_preferences (preferences never leave this machine) — and refuses outright if it finds a credential — it will not redact and send anyway; crbro_forget it and rotate it. Show the user that report and get their agreement before confirming, then call again with the confirm_token; a stale token is refused. Entries go out on the next crbro_sync or consolidate. Once shared, everything you learn about that project flows to the team automatically; everything else in your brain stays private.',
    {
      neuron: z.string().describe('Neuron ID or name to share'),
      space: z.string().describe('Name of the space, as created or joined with crbro_space'),
      confirm: z.string().optional().describe('The confirm_token from the dry run — only returned when no credential was found. Omit it the first time.'),
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
  server.tool(
    'crbro_sync',
    'Exchange notes with your team right now, instead of waiting for the next boot or consolidate — both sync on their own; use this mid-session, e.g. after crbro_share. Pulls what everyone else recorded and sends yours, reporting per space: state, neurons updated, new facts, teammates seen, pushed. Being offline is a normal answer, not a failure: your memory works either way and pending notes go out next time.',
    {
      space: z.string().optional().describe('Name of one space; state comes back "not_joined" if you are not in it. Omit to sync all of them.'),
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
