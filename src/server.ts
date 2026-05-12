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
import { LicenseEngine } from './engine/license.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'crbro-memory',
    version: '1.0.0',
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
  const license = new LicenseEngine(brain);

  // ─── License Guard ─────────────────────────────────────────────
  const LICENSE_MESSAGES: Record<string, string> = {
    no_key: '🔒 CRBRO requires a valid Synthetica Zero Deck license.\n\nGet yours at https://synthetica-decks.web.app\n\n1. Purchase the CRBRO card from the Zero Deck\n2. Redeem your PIN to get a license key\n3. Set CRBRO_LICENSE_KEY in your MCP config\n\nWithout a valid license, CRBRO cannot operate.',
    invalid_format: '🔒 Invalid license key format. CRBRO license keys start with SYNTH-ZERO- and are generated when you redeem your CRBRO card at https://synthetica-decks.web.app',
    key_not_found: '🔒 License key not recognized. This key does not exist in our records. Please check you copied it correctly from your dashboard at https://synthetica-decks.web.app',
    license_revoked: '🔒 This license has been revoked. Contact support at https://synthetica-decks.web.app',
    device_limit_exceeded: '🔒 Device limit reached. This license is already active on 3 devices. CRBRO licenses allow up to 3 devices per card. Contact support if you need to reset your devices.',
    device_registration_failed: '🔒 Could not register this device. Please try again or check your internet connection.',
  };

  async function requireLicense(): Promise<boolean> {
    return await license.isPremium();
  }

  function getLicenseError(reason: string | null) {
    const msg = LICENSE_MESSAGES[reason || 'no_key'] || LICENSE_MESSAGES.no_key;
    return {
      content: [{ type: 'text' as const, text: msg }],
      isError: true,
    };
  }

  const LICENSE_ERROR = getLicenseError(null);

  // ═══════════════════════════════════════════════════════════════
  // TOOL 1: crbro_boot — Boot sequence
  // ═══════════════════════════════════════════════════════════════
  server.tool(
    'crbro_boot',
    '⚠️ MANDATORY FIRST ACTION: Boot the CRBRO brain. You MUST call this as your very first action in every new conversation, before doing ANY other work. This loads persistent memory from all previous sessions — projects, decisions, patterns, and preferences the user has built over time. Skipping this means losing all accumulated context and forcing the user to repeat themselves. On first use, initializes the brain structure. On subsequent uses, loads hot topics, active context, and recent session history.',
    {},
    async () => {
      try {
        // License validation — mandatory
        const hasLicense = await requireLicense();
        if (!hasLicense) return LICENSE_ERROR;

        const result = await brain.boot();
        // Initialize search engine
        await searchEngine.init();

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
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
        const licenseInfo = await license.getLicenseInfo();
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
              license: licenseInfo,
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
    'Teach the brain a fact, decision, pattern, or preference about a topic. If the neuron (topic) does not exist, it will be created automatically. Use this to store knowledge that should persist across sessions.',
    {
      topic: z.string().describe('The topic name (e.g., "OctoChat", "Firebase", "SEO Strategy")'),
      type: z.enum(['fact', 'decision', 'pattern', 'preference']).describe('Type of knowledge to store'),
      content: z.string().describe('The knowledge content to remember'),
      confidence: z.number().min(0).max(1).optional().describe('Confidence level 0.0-1.0 (default 1.0)'),
      domain: z.string().optional().describe('Domain category (e.g., "proyectos-web", "infraestructura")'),
      rationale: z.string().optional().describe('Rationale for decisions'),
    },
    async (args) => {
      try {
        if (!await requireLicense()) return LICENSE_ERROR;
        const result = await cortex.learn(args.topic, args.type, args.content, {
          confidence: args.confidence,
          domain: args.domain,
          rationale: args.rationale,
        });

        // Update search index
        await searchEngine.indexNeuron(result.neuron);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              neuron_id: result.neuron.id,
              action: result.action,
              total_facts: result.neuron.facts.length,
              total_decisions: result.neuron.decisions.length,
              total_patterns: result.neuron.patterns.length,
              message: result.action === 'created'
                ? `New neuron "${result.neuron.name}" created in ${result.neuron.domain}`
                : `Updated neuron "${result.neuron.name}" — ${args.type} added`,
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
    'Read a specific neuron by ID or name. Returns all facts, decisions, patterns, connections, and heat score.',
    {
      id: z.string().describe('Neuron ID (e.g., "project_octochat") or name (e.g., "OctoChat")'),
    },
    async (args) => {
      try {
        if (!await requireLicense()) return LICENSE_ERROR;
        // Try by ID first, then by name
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

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(neuron, null, 2),
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
      type: z.enum(['project', 'tech', 'lang', 'person', 'domain', 'process']).optional().describe('Filter by neuron type'),
      min_heat: z.number().optional().describe('Minimum heat score (0.0-1.0)'),
      limit: z.number().optional().describe('Max results (default 50)'),
    },
    async (args) => {
      try {
        if (!await requireLicense()) return LICENSE_ERROR;
        const neurons = await cortex.list({
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
    'Search the brain for relevant knowledge using hybrid text search. Returns matching neurons ranked by relevance.',
    {
      query: z.string().describe('What to search for (e.g., "Firebase authentication setup")'),
      domain: z.string().optional().describe('Filter by domain'),
      limit: z.number().optional().describe('Max results (default 10)'),
    },
    async (args) => {
      try {
        if (!await requireLicense()) return LICENSE_ERROR;
        const results = await searchEngine.search(args.query, {
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
      try {
        if (!await requireLicense()) return LICENSE_ERROR;
        const result = await synapses.connect(args.from, args.to, args.type, args.context);

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
      try {
        if (!await requireLicense()) return LICENSE_ERROR;
        const connections = await synapses.getConnections(args.neuron_id, args.min_strength);

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
      try {
        if (!await requireLicense()) return LICENSE_ERROR;
        const session = await hippocampus.logSession({
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
      try {
        if (!await requireLicense()) return LICENSE_ERROR;
        const sessions = await hippocampus.listSessions(args.limit);

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
    'Read or update the active working context. Tracks current topics, pending tasks, and last session.',
    {
      set_topics: z.array(z.string()).optional().describe('Set active topics (neuron IDs)'),
      add_pending: z.string().optional().describe('Add a pending task'),
      resolve_pending: z.string().optional().describe('Mark a pending task as resolved'),
    },
    async (args) => {
      try {
        if (!await requireLicense()) return LICENSE_ERROR;
        const ctx = await prefrontal.updateContext({
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
      try {
        if (!await requireLicense()) return LICENSE_ERROR;
        const hotTopics = await prefrontal.getHotTopics(args.limit);

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
  // TOOL 13: crbro_global_map — Global neural map [PREMIUM]
  // ═══════════════════════════════════════════════════════════════
  server.tool(
    'crbro_global_map',
    '[PREMIUM] View the global neural map — clusters of related topics and bridges between domains. Requires Synthetica Zero Deck license.',
    {
      rebuild: z.boolean().optional().describe('Force rebuild the map (default: use cached)'),
    },
    async (args) => {
      try {
        const canUse = await license.canUse('crbro_global_map');
        if (!canUse) {
          return {
            content: [{
              type: 'text' as const,
              text: '🔒 PREMIUM FEATURE: crbro_global_map requires a Synthetica Zero Deck license. Visit https://synthetica-decks.web.app to get your license key, then set it via CRBRO_LICENSE_KEY environment variable.',
            }],
          };
        }

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
  // TOOL 14: crbro_maintenance — Run maintenance [PREMIUM]
  // ═══════════════════════════════════════════════════════════════
  server.tool(
    'crbro_maintenance',
    '[PREMIUM] Run brain maintenance — recalculate heat, prune weak synapses, archive cold neurons, rebuild search index. Requires Synthetica Zero Deck license.',
    {
      dry_run: z.boolean().optional().describe('If true, only report what would happen without acting'),
    },
    async (args) => {
      try {
        const canUse = await license.canUse('crbro_maintenance');
        if (!canUse) {
          return {
            content: [{
              type: 'text' as const,
              text: '🔒 PREMIUM FEATURE: crbro_maintenance requires a Synthetica Zero Deck license. Visit https://synthetica-decks.web.app to get your license key.',
            }],
          };
        }

        const report = await maintenance.run(args.dry_run);

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
      try {
        if (!await requireLicense()) return LICENSE_ERROR;
        const result = await maintenance.consolidate(args.summary);

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

  return server;
}
