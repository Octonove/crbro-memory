// ─── CRBRO MCP Server ────────────────────────────────────────────
// Main server with all 22 tools registered

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
    version: '1.8.2',
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
    '⚠️ MANDATORY FIRST ACTION: Boot the CRBRO brain. You MUST call this as your very first action in every new conversation, before doing ANY other work. This loads persistent memory from all previous sessions — projects, decisions, patterns, and preferences the user has built over time. Skipping this means losing all accumulated context and forcing the user to repeat themselves. On first use, initializes the brain structure. On subsequent uses, loads hot topics, active context, and recent session history.',
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
    'Get the current status of the CRBRO brain — total neurons, synapses, sessions, and brain path.',
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
    'Teach the brain a fact, decision, pattern, preference or error about a topic. If the neuron (topic) does not exist, it will be created automatically. Use this to store knowledge that should persist across sessions. BEFORE saving, walk the ladder: does this already exist (crbro_recall first)? does it update something (pass `supersedes`, do not add a sibling)? is it structure rather than an event (crbro_map, not a fact)? is it derivable from the repo or git history (then do not store it)? and would it survive losing half its words (then cut them - every word should carry weight)? Type `error` is for a mistake you made and how it was corrected - store both halves in one entry, and check for them with crbro_recall before repeating a task where you have slipped before. Type `debt` is the twin for deliberate deferrals - what was skipped on purpose, its ceiling, and when to revisit; before re-proposing or re-discussing something, recall may surface that it was already deferred with a reason. If the new fact closely resembles an active one, the response warns with `near_duplicates` - it is stored anyway, but retire the old telling or two versions keep coming back on recall as equals.',
    {
      topic: z.string().describe('The topic name (e.g., "OctoChat", "Firebase", "SEO Strategy")'),
      type: z.enum(['fact', 'decision', 'pattern', 'preference', 'error', 'debt']).describe('Type of knowledge to store. `error` = a mistake plus its correction, kept as a ledger you can check before repeating the task. `debt` = a deliberate deferral: what was NOT done on purpose, its ceiling, and the condition to revisit — write all three in one entry, e.g. "DEFERRED: protecting the PDFs. CEILING: anyone can download the lead magnets without signing up. REVISIT WHEN: the signup flow works." When someone re-proposes a dead idea, recall serves the decision with its date and trigger.'),
      content: z.string().describe('The knowledge content to remember'),
      confidence: z.number().min(0).max(1).optional().describe('Confidence level 0.0-1.0 (default 1.0)'),
      domain: z.string().optional().describe('Domain category (e.g., "proyectos-web", "infraestructura")'),
      rationale: z.string().optional().describe('Rationale for decisions'),
      neuron_id: z.string().optional().describe('Exact neuron ID to write to (e.g. "project_octochat"). Pass the neuron_id you got back from crbro_recall: it skips name matching entirely and guarantees the knowledge lands where you mean.'),
      supersedes: z.array(z.string()).optional().describe('Facts this one replaces: their ids, or their exact text. They stop showing up in recall but stay in the neuron file.'),
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
    'Read a specific neuron by ID or name. Returns its facts (newest first), decisions, patterns, connections and heat. Big neurons are paginated - page through them with offset instead of trying to pull everything at once.',
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
    'List all neurons in the brain with optional filters. Returns ID, name, domain, heat, and facts count.',
    {
      domain: z.string().optional().describe('Filter by domain (e.g., "proyectos-web")'),
      type: z.enum(['project', 'tech', 'lang', 'person', 'domain', 'process', 'protocol']).optional().describe('Filter by neuron type'),
      min_heat: z.number().optional().describe('Minimum heat score (0.0-1.0)'),
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
    'Search the brain for knowledge saved in earlier sessions. Searches the full text of every fact, decision, pattern, error and system map, not just topic names, and each result carries the exact chunk that matched plus the date it was recorded. Call this before asking the user something they may already have told you, and before assuming a past decision. A result with has_map: true belongs to a neuron that keeps a system map - read it with crbro_map before touching that system. If a result looks right, pass its neuron_id back to crbro_learn so new knowledge lands in the same place.',
    {
      query: z.string().describe('What to search for (e.g., "Firebase authentication setup")'),
      domain: z.string().optional().describe('Filter by domain'),
      limit: z.number().optional().describe('Max results (default 10)'),
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
    'Create or strengthen a connection (synapse) between two neurons. Synapses track relationships and strengthen with repeated co-access.',
    {
      from: z.string().describe('Source neuron ID'),
      to: z.string().describe('Target neuron ID'),
      type: z.enum(['dependency', 'causal', 'temporal', 'conceptual', 'hierarchy', 'alternative']).describe('Connection type'),
      context: z.string().optional().describe('Description of the relationship'),
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
    'Get all connections (synapses) for a specific neuron. Shows related topics with connection strength and type.',
    {
      neuron_id: z.string().describe('Neuron ID to get connections for'),
      min_strength: z.number().optional().describe('Minimum synapse strength (0.0-1.0)'),
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
    'Log a session summary to the hippocampus. Call at the end of a work session to record what was done.',
    {
      summary: z.string().describe('Summary of what happened in this session'),
      topics_touched: z.array(z.string()).describe('List of neuron IDs that were relevant'),
      key_facts_added: z.number().optional().describe('Number of new facts stored'),
      decisions_made: z.number().optional().describe('Number of decisions recorded'),
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
    'List recent session logs from the hippocampus.',
    {
      limit: z.number().optional().describe('Number of sessions to return (default 10)'),
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
    'Read or update the active working context: current topics, open items and last session. Close items as soon as they are done - an item left open here gets repeated back to the user in later sessions long after it was finished.',
    {
      set_topics: z.array(z.string()).optional().describe('Set active topics (neuron IDs)'),
      add_pending: z.string().optional().describe('Add an open item. Write it so it can be checked later, not as a vague reminder.'),
      resolve_pending: z.string().optional().describe('Close an open item: its id (e.g. "p_ab12cd"), or enough of its text to identify it. It moves to recently_closed.'),
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
    'Get the hottest topics — neurons with the highest heat scores (based on frequency, recency, and connectivity).',
    {
      limit: z.number().optional().describe('Number of topics to return (default 15)'),
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
    'View the global neural map — clusters of related topics and bridges between domains.',
    {
      rebuild: z.boolean().optional().describe('Force rebuild the map (default: use cached)'),
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
    'Run brain maintenance: recalculate heat, prune weak synapses, check integrity and rebuild the search index. Archiving cold neurons is OFF unless you ask for it - on a mature brain most neurons look cold, and archived ones stop being searchable.',
    {
      dry_run: z.boolean().optional().describe('If true, only report what would happen without acting'),
      archive: z.boolean().optional().describe('Also move cold neurons (heat < 0.05, untouched 90+ days) out of the cortex. Off by default. Run with dry_run first and read archivable_neurons before turning this on.'),
      purge_boilerplate: z.boolean().optional().describe('Also delete contentless facts left by early versions of the miner ("Referenced in: file.md"). Off by default; every run reports how many there are.'),
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
    '⚠️ CALL BEFORE SESSION ENDS: Consolidate the brain at end of session. You MUST call this before the conversation ends if ANY significant work was done (code changes, decisions made, new information learned). This persists all new knowledge, logs the session summary, recalculates topic heat scores, and updates the manifest. Failing to consolidate means this entire session\'s knowledge is permanently lost. Always provide a meaningful summary of what was accomplished.',
    {
      summary: z.string().describe('Summary of the session being consolidated'),
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
    'Read or replace the system map of a neuron. A map is ONE living document answering: where does this system live, what serves what, which pieces talk to each other, and what are the traps that cost hours. Read it BEFORE working on a system you have touched in past sessions - it is the difference between continuing and re-discovering. After building or changing a system, rewrite the whole map so it stays true: pass `content` and it replaces the previous version entirely (append-only maps rot). Without `content` it returns the current map.',
    {
      neuron: z.string().describe('Neuron ID or name (e.g. "project_octochat" or "OctoChat")'),
      content: z.string().optional().describe('The new map, replacing the old one whole. Omit to read. Write it as the reference you will need next time: paths, ids, what-serves-what, gotchas.'),
      domain: z.string().optional().describe('Domain for the neuron if it has to be created (e.g. "proyectos-web")'),
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
    'Mark stored facts as no longer current. Use this the moment you discover something you saved is out of date or was wrong: a memory that only ever appends keeps serving the old version alongside the new one, with equal confidence. Superseded facts disappear from crbro_recall but stay in the neuron file, so nothing is lost and the correction is auditable.',
    {
      neuron: z.string().describe('Neuron ID or name holding the facts (e.g. "project_octochat")'),
      facts: z.array(z.string()).describe('Which facts to retire: their ids, or their exact text.'),
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
    'Check the brain for credentials that were stored before they could be filtered out — API keys, tokens, passwords. Reports which neurons hold them and what kind, never the values themselves. Run it once after upgrading, and any time you suspect a secret was pasted into a conversation. Use crbro_forget to remove what it finds.',
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
    'Store and read credentials in the operating system own keychain — macOS Keychain, the Linux Secret Service, or DPAPI on Windows. CRBRO keeps no copy and invents no crypto: it brokers access to the store the machine already has, outside the brain, where no sync and no team space can reach it. Use it the moment the user hands you a credential: store it here, then record only the NAME with crbro_learn, never the value. Use get when a task needs one, and do not print the value back to the user unless they asked for that specific secret. Names are SCREAMING_SNAKE_CASE, e.g. WORDPRESS_APP_PASSWORD.',
    {
      action: z.enum(['get', 'set', 'list', 'remove', 'status'])
        .describe('get = read one, set = store or update one, list = names only, remove = delete one, status = which keychain this machine offers'),
      name: z.string().optional().describe('Secret name in SCREAMING_SNAKE_CASE'),
      value: z.string().optional().describe('The credential itself. Only for set.'),
      description: z.string().optional().describe('What it is for, e.g. "WordPress example.com - REST API"'),
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
    'Permanently remove entries from a neuron. This is for things that must not exist at all — a credential, personal data, something stored by mistake. It removes facts, decisions, patterns, preferences and errors matched by id or exact text, and the system map when given its exact full text (or clear the map with crbro_map and empty content). For knowledge that merely stopped being true, use crbro_revise instead, which keeps the history. The whole neuron is copied to .quarantine/ before anything is removed, so a mistake can be undone by hand. On shared neurons the removal travels: facts retract, errors are purged, a cleared map stays cleared. Always tell the user what you are about to remove and get their agreement first.',
    {
      neuron: z.string().describe('Neuron ID or name holding the entries'),
      facts: z.array(z.string()).describe('What to remove: fact ids, or the exact text of a fact, decision, pattern or preference'),
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
    'Set up shared memory with teammates. A space is a private git repository holding notes about the projects you choose to share — nothing else from your brain goes near it. One person runs create with the repository URL; everyone else runs join with the same URL. After that it syncs by itself at the start and end of every session.',
    {
      action: z.enum(['create', 'join', 'status']).describe('create = start a new space, join = enter one a teammate created, status = what you are in'),
      name: z.string().optional().describe('Short name for the space, e.g. "equipo". Same on everyone\'s machine.'),
      remote: z.string().optional().describe('Git URL of an EMPTY private repository, e.g. git@github.com:acme/team-memory.git'),
      author: z.string().optional().describe('How your notes are signed, e.g. "ana". Lowercase, no spaces.'),
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
    'Share one neuron with a team space. Always run it without a token first: it reports exactly what would be sent and refuses outright if it finds a credential — it will not redact and send anyway. Show the user that report and get their agreement before confirming. Once shared, everything you learn about that project flows to the team automatically; everything else in your brain stays private.',
    {
      neuron: z.string().describe('Neuron ID or name to share'),
      space: z.string().describe('Name of the space'),
      confirm: z.string().optional().describe('The confirm_token from the dry run. Omit it the first time.'),
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
    'Exchange notes with your team right now, instead of waiting for the next boot or consolidate. Pulls what everyone else recorded and sends yours. Being offline is a normal answer, not a failure: your memory works either way and pending notes go out next time.',
    {
      space: z.string().optional().describe('Which space. Omit to sync all of them.'),
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
