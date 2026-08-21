// ─── CRBRO MCP Server ────────────────────────────────────────────
// Main server with all 15 tools registered

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { Brain } from './engine/brain.js';
import { Cortex } from './engine/cortex.js';
import { Synapses } from './engine/synapses.js';
import { HeatEngine } from './engine/heat.js';
import { Hippocampus } from './engine/hippocampus.js';
import { Prefrontal } from './engine/prefrontal.js';
import { SearchEngine } from './search/index.js';
import { Maintenance } from './engine/maintenance.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'crbro-memory',
    version: '1.5.2',
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

  // v1.4.0: CRBRO is fully free — all 15 tools, no license, no network calls.
  // The former license engine (Firestore-backed freemium) lives in git history
  // before this version if it is ever needed again.

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
              version: manifest.version,
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
    'Teach the brain a fact, decision, pattern, or preference about a topic. If the neuron (topic) does not exist, it will be created automatically. Use this to store knowledge that should persist across sessions. If this replaces something you stored before, pass `supersedes` - otherwise the old version stays exactly as valid as the new one and both keep coming back on recall.',
    {
      topic: z.string().describe('The topic name (e.g., "OctoChat", "Firebase", "SEO Strategy")'),
      type: z.enum(['fact', 'decision', 'pattern', 'preference']).describe('Type of knowledge to store'),
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
    'Search the brain for knowledge saved in earlier sessions. Searches the full text of every fact, decision and pattern, not just topic names, and each result carries the exact fact that matched plus the date it was recorded. Call this before asking the user something they may already have told you, and before assuming a past decision. If a result looks right, pass its neuron_id back to crbro_learn so new knowledge lands in the same place.',
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
                : 'matching_content is the fact that matched; matched_added is when it was recorded. Prefer recent facts when two disagree.',
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
    },
    async (args) => {
      try {
        const report = await maintenance.run(args.dry_run, { archive: args.archive });

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

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ...result,
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
              message: result.revised > 0
                ? `${result.revised} fact(s) retired in "${result.neuron.name}". They no longer appear in recall.`
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

  return server;
}
