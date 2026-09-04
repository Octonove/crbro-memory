// ─── CRBRO MCP Server ────────────────────────────────────────────
// Main server with the 15 tools of the 2.0 surface registered.
//
// Every tool goes through registerTool with a title, MCP annotations
// (readOnlyHint / destructiveHint / idempotentHint / openWorldHint) and, for
// the read tools with a stable shape, an outputSchema honoured with
// structuredContent. The descriptions state what the tool does, when to use
// it over its siblings, its side effects and what it returns — and nothing
// else: the discipline of using the memory well is said once, at boot, in
// memory_discipline, because these definitions are paid on every request in
// clients that load all tools.
//
// 2.0 folded the nine read/duplicate tools of 1.x (status, neuron, neurons,
// hot_topics, connections, sessions, global_map, session_log, sync) into
// crbro_inspect, crbro_space action=sync and crbro_consolidate. RETIRED_TOOLS
// below is the only place the old names survive: boot serves it so a client
// with an old habit finds the replacement without a round trip.

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
import { semanticStatus } from './search/semantic.js';
import { Maintenance } from './engine/maintenance.js';
import {
  createSpace, joinSpace, listSpaces, readSpace, prepareShare, commitShare,
  syncSpaceNow, syncAll, getIdentity, attachSync, sharedMap, unshareNeuron, leaveSpace,
} from './sync/space.js';
import {
  detectBackend, setSecret, getSecret, listSecrets, removeSecret, KeychainUnavailable,
} from './engine/keychain.js';
import { readJSON } from './utils/fs.js';
import { contentHash } from './utils/hash.js';
import type { HotTopics, Neuron } from './types/index.js';

/**
 * Old tool name → how to do the same thing on the 2.0 surface. Served by
 * crbro_boot as `retired_tools` for the whole 2.x line, and asserted by the
 * definitions test. Keys are the ONLY place a retired name may appear in a
 * string the model receives.
 */
export const RETIRED_TOOLS: Readonly<Record<string, string>> = {
  crbro_status: 'crbro_inspect view=status',
  crbro_neuron: 'crbro_inspect view=neuron neuron=<id or name>',
  crbro_neurons: 'crbro_inspect view=neurons [domain|type|min_heat|limit|offset]',
  crbro_hot_topics: 'crbro_inspect view=neurons (rows) and crbro_inspect view=status (hot_topics_recalculated)',
  crbro_connections: 'crbro_inspect view=neuron neuron=<id> [min_strength]',
  crbro_sessions: 'crbro_inspect view=sessions [limit]',
  crbro_global_map: 'crbro_inspect view=global_map',
  crbro_session_log: 'crbro_consolidate summary=... [topics_touched=[...] for neuron ids you only read] (logs the session) plus crbro_context set_topics=[...] if you need to replace the active topics',
  crbro_sync: 'crbro_space action=sync [name]',
};

/** The one sentence about the lifecycle, shared by three descriptions and boot. */
const THREE_STAGES =
  'A new truth that REPLACES an old one → crbro_learn with supersedes (one call does both). ' +
  'Something stopped being true, or was never true, and nothing replaces it → crbro_revise ' +
  '(kept in the file, gone from recall, reversible with status active). Something must not exist ' +
  'on disk at all — a credential, personal data, a whole neuron → crbro_forget (quarantine copy first).';

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

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true as const } : {}) };
}

function jsonResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(where: string, err: unknown) {
  return textResult(`CRBRO ${where} error: ${err instanceof Error ? err.message : String(err)}`, true);
}

const NEURON_TYPES = ['project', 'tech', 'lang', 'person', 'domain', 'process', 'protocol'] as const;
const INSPECT_VIEWS = ['status', 'neuron', 'neurons', 'sessions', 'global_map'] as const;

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

  // The mirror of the indexer: when a neuron leaves the cortex (forget entire,
  // merge_into) its chunks leave the index too. The index is derived data, so
  // a failure here is swallowed by the cortex like a failed reindex.
  cortex.setRemover(id => searchEngine.removeNeuron(id));

  // When a neuron belongs to a shared space, every write also appends a note
  // to this machine's own log. Nobody ever writes to anyone else's file, so
  // two people working at once have nothing to collide over.
  attachSync(brain, cortex);

  // v1.4.0: CRBRO is fully free — no license, no network calls. The former
  // license engine (Firestore-backed freemium) lives in git history before
  // that version if it is ever needed again.

  /** id first, then name — the resolution every neuron-taking tool shares. */
  const resolveNeuron = async (ref: string): Promise<Neuron | null> =>
    (await cortex.peek(ref)) || (await cortex.findByName(ref));

  // ═══════════════════════════════════════════════════════════════
  // TOOL 1: crbro_boot — Boot sequence
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_boot',
    {
      title: 'Boot the brain',
      description: 'Read the brain at session start — call it FIRST in every conversation, before any other work; writes only the boot stamp (and the brain itself on first use). Loads memory from earlier sessions: hot topics, active context with open_items and recently_closed (never report recently_closed as pending; verify open_items before repeating them), recent_sessions, counts, active protocols as a protocol_enforcement block you must follow, memory_discipline (the rules for using this memory well) and retired_tools (old tool names → their replacement). Readies the search index and syncs shared team spaces (offline is normal). Skipping it loses all context; close the session with crbro_consolidate.',
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

        // The last three real session logs, and last_session taken from them:
        // the manifest field brain.boot reads was never written by anything,
        // so it came back null in every session.
        response.recent_sessions = await hippocampus.listSessions(3);
        response.last_session = response.recent_sessions[0]?.session_id ?? result.last_session ?? null;
        response.retired_tools = RETIRED_TOOLS;

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
        // tools/list in 1.13: the definitions cost thousands of tokens on every
        // request in clients that load all tools; this paragraph costs ~250, once.
        // Semantic recall is installed by init since 1.16; say so once when
        // it is missing, so the agent can offer the one command that fixes it.
        const sem = semanticStatus();
        if (!sem.installed && sem.mode !== 'disabled') {
          (response as Record<string, unknown>).semantic_hint =
            'Semantic recall is not installed on this machine: run once npx crbro-memory init (about 500 MB). ' +
            'Until then recall is keyword-only; keywords at save time still work.';
        }

        response.memory_discipline =
          'Before crbro_learn, crbro_recall: what you are about to save may already exist — then pass ' +
          'supersedes instead of adding a sibling (two versions of one fact compete on recall as equals). ' +
          'crbro_recall searches by content; to read one neuron by id or name, list neurons, sessions or ' +
          'the global map, use crbro_inspect. ' +
          'Structure — paths, what serves what, traps — goes in crbro_map, not in facts; anything derivable ' +
          'from the repo or git history is not worth storing. Write facts dense and self-contained: they are ' +
          'recalled without this conversation, and add keywords: the words a future question may use that ' +
          'the text lacks. On recall, ask several ways (queries) before concluding a thing is not stored. ' +
          'type:error keeps a mistake with its fix; type:debt keeps a ' +
          'deliberate deferral with its ceiling and revisit trigger. Credentials never go in the brain: ' +
          'crbro_secret, then record only the NAME. Recall results carry confidence — "weak" means the match ' +
          'covers little of the question, verify before relying on it — and when two facts disagree, prefer ' +
          'the more recent. ' + THREE_STAGES + ' ' +
          'Call crbro_consolidate before the conversation ends; it logs the session too.';

        return jsonResult(response);
      } catch (err) {
        return errorResult('boot', err);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 2: crbro_inspect — Read-only views of the brain
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_inspect',
    {
      title: 'Inspect the brain',
      description: 'Read-only views of the brain by id or name; to search by content use crbro_recall. Nothing is written by any view: every read leaves the brain untouched. view=status: version, brain path, totals, last boot/consolidation, semantic state, hot_topics_recalculated. view=neuron: one neuron in full — facts newest first, paged with limit/offset (superseded hidden unless include_superseded), decisions, patterns, preferences, errors, debts, entry_status, system map, and its connections resolved with name, type and strength (min_strength filters). view=neurons: rows hottest first (id, name, domain, type, heat, last_accessed, facts_count), filtered by domain, type, min_heat, paged with limit/offset. view=sessions: day logs newest first, the only place session summaries are read. view=global_map: one cluster per domain plus cross-domain bridges, computed live. Params of other views are ignored.',
      inputSchema: {
        view: z.enum(INSPECT_VIEWS).describe('Which read to perform. Only the params listed for that view are honoured; the rest are ignored, never an error.'),
        neuron: z.string().optional().describe('view=neuron only, required there: neuron id (e.g. "project_octochat") or name (e.g. "OctoChat").'),
        domain: z.string().optional().describe('view=neurons: exact domain match, e.g. "proyectos-web".'),
        type: z.enum(NEURON_TYPES).optional().describe('view=neurons: only this neuron type.'),
        min_heat: z.number().min(0).max(1).optional().describe('view=neurons: minimum heat, 0.0-1.0. Heat blends access frequency, recency and connectivity.'),
        min_strength: z.number().min(0).max(1).optional().describe('view=neuron: drop connections weaker than this (0.0-1.0). Omit or 0 = all.'),
        limit: z.number().int().positive().optional().describe('Page size. view=neuron: facts per page (default 40, max 200); view=neurons: rows (default 50, max 500); view=sessions: day logs (default 10, max 100). Other views ignore it.'),
        offset: z.number().int().min(0).optional().describe('Items to skip. view=neuron: facts (newest first); view=neurons: rows after the heat sort. Default 0.'),
        include_superseded: z.boolean().optional().describe('view=neuron: also return superseded and retracted facts (default false). Retired decisions, patterns, errors and debts are always returned, with entry_status saying which are retired.'),
      },
      outputSchema: {
        view: z.enum(INSPECT_VIEWS),
        status: z.object({
          crbro_version: z.string(),
          brain_format: z.string().optional(),
          total_neurons: z.number(),
          total_synapses: z.number(),
          total_sessions: z.number(),
          brain_path: z.string().optional(),
          last_boot: z.string().nullable().optional(),
          last_consolidation: z.string().nullable().optional(),
          semantic: z.object({ installed: z.boolean(), enabled: z.boolean(), mode: z.string(), model_downloaded: z.boolean(), home: z.string(), model: z.string() }).optional(),
          hot_topics_recalculated: z.string().nullable(),
        }).optional(),
        neuron: z.object({}).loose().optional(),
        neurons: z.object({
          total: z.number(),
          offset: z.number(),
          neurons: z.array(z.object({
            id: z.string(), name: z.string(), domain: z.string(), type: z.string(),
            heat: z.number(), last_accessed: z.string(), facts_count: z.number(),
          }).loose()),
        }).optional(),
        sessions: z.object({
          total: z.number(),
          sessions: z.array(z.object({
            session_id: z.string().optional(), date: z.string().optional(), summary: z.string().optional(),
            topics_touched: z.array(z.string()).optional(),
            key_facts_added: z.number().optional(), decisions_made: z.number().optional(),
          }).loose()),
        }).optional(),
        global_map: z.object({
          total_clusters: z.number(),
          total_bridges: z.number(),
          computed_at: z.string(),
          clusters: z.array(z.object({}).loose()),
          bridges: z.array(z.object({}).loose()),
        }).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const done = (payload: unknown) => ({
          content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: { view: args.view, [args.view]: payload },
        });

        if (args.view === 'status') {
          const manifest = await brain.getManifest();
          const hot = await readJSON<HotTopics>(brain.paths.hotTopics());
          return done({
            crbro_version: runningVersion(),
            brain_format: manifest.version,
            total_neurons: manifest.total_neurons,
            total_synapses: manifest.total_synapses,
            total_sessions: manifest.total_sessions,
            brain_path: manifest.brain_path,
            last_boot: manifest.last_boot,
            last_consolidation: manifest.last_consolidation,
            semantic: semanticStatus(),
            hot_topics_recalculated: hot?.last_recalculated ?? null,
          });
        }

        if (args.view === 'neuron') {
          if (!args.neuron) {
            return textResult('view=neuron needs `neuron`: a neuron id or name.', true);
          }
          // peek, not get: a tool that declares readOnlyHint must not write.
          // get() stamps last_accessed and access_count, which made this view
          // contradict its own annotation. Heat keeps its frequency signal from
          // the write paths (learn, map), and crbro_recall — the read an agent
          // actually makes — never bumped either.
          let neuron = await cortex.peek(args.neuron);
          if (!neuron) {
            const found = await cortex.findByName(args.neuron);
            if (found) neuron = await cortex.peek(found.id);
          }
          if (!neuron) {
            return textResult(
              `Neuron not found: "${args.neuron}". Find the id with crbro_recall or crbro_inspect view=neurons.`, true);
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
          const connections = await synapses.getConnections(neuron.id, args.min_strength);

          return done({
            ...neuron,
            connection_ids: neuron.connections || [],
            connections,
            total_connections: connections.length,
            facts: page,
            facts_pagination: {
              total: ordered.length,
              returned: page.length,
              offset,
              has_more: offset + page.length < ordered.length,
              order: 'newest first',
              hidden_superseded: (neuron.facts || []).length - visible.length,
            },
          });
        }

        if (args.view === 'neurons') {
          const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
          const offset = Math.max(args.offset ?? 0, 0);
          const rows = await cortex.list({
            domain: args.domain,
            type: args.type,
            min_heat: args.min_heat,
            limit,
            offset,
          });
          return done({ total: rows.length, offset, neurons: rows });
        }

        if (args.view === 'sessions') {
          const limit = Math.min(Math.max(args.limit ?? 10, 1), 100);
          const sessions = await hippocampus.listSessions(limit);
          return done({ total: sessions.length, sessions });
        }

        // view === 'global_map': computed live, never cached, nothing written.
        const globalMap = await prefrontal.getGlobalMap();
        return done({
          total_clusters: globalMap.clusters.length,
          total_bridges: globalMap.bridges.length,
          computed_at: globalMap.last_rebuilt,
          clusters: globalMap.clusters,
          bridges: globalMap.bridges,
        });
      } catch (err) {
        return errorResult('inspect', err);
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
      description: 'Write: store a fact, decision, pattern, preference, error or debt on a topic; the neuron is created if missing (or pass neuron_id). Stage 1 of the lifecycle: a new truth that REPLACES an old one → crbro_learn with supersedes (one call does both); to retire with no replacement use crbro_revise; to delete from disk use crbro_forget. crbro_recall first — it may already exist. The same fact text again is not duplicated: keywords merge (or keywords_replace) and a changed confidence applies (updated_in_place); text matching a retired fact or entry is refused with skipped_retired. Decisions always append; preferences never leave this machine. Credentials are replaced with a marker and listed in redacted — crbro_secret them, record only the name. Returns neuron_id, action, superseded count, near_duplicates (stored anyway; retire the old telling), supersedes_unmatched (still live) and totals.',
      inputSchema: {
        topic: z.string().describe('Topic name, e.g. "OctoChat", "Firebase", "SEO Strategy".'),
        type: z.enum(['fact', 'decision', 'pattern', 'preference', 'error', 'debt']).describe('error = a mistake plus its correction, in one entry. debt = a deliberate deferral: what was NOT done on purpose, its ceiling, and the revisit condition, e.g. "DEFERRED: protecting the PDFs. CEILING: anyone can download them without signing up. REVISIT WHEN: the signup flow works."'),
        content: z.string().describe('The knowledge itself. Dense and self-contained: it is recalled without this conversation as context.'),
        confidence: z.number().min(0).max(1).optional().describe('0.0-1.0, default 1.0. Facts only. On an exact-duplicate active fact the stored confidence is updated to this value (updated_in_place:true).'),
        domain: z.string().optional().describe('Domain, e.g. "proyectos-web". Applied when the neuron is created; on an existing neuron it only replaces the default "general" (crbro_revise domain replaces it unconditionally).'),
        rationale: z.string().optional().describe('Why the decision was taken. Stored and indexed with it; ignored for other types.'),
        neuron_id: z.string().optional().describe('Exact neuron id from crbro_recall, e.g. "project_octochat". Skips name matching entirely.'),
        supersedes: z.array(z.string()).optional().describe('Facts this one replaces: their ids or exact text. They leave recall but stay in the file. Unmatched targets are reported and stay live.'),
        keywords: z.array(z.string()).optional().describe('Facts only. 2-5 words a future question may use that the text does not contain: synonyms, the other language, the generic name of the product named. Indexed with the fact, never shown. The same text again with new keywords merges them.'),
        keywords_replace: z.boolean().optional().describe('When the exact fact text already exists, replace its stored keywords with `keywords` instead of merging (default false). Teammates in a shared space only ever receive the union.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = await cortex.learn(args.topic, args.type, args.content, {
          confidence: args.confidence,
          domain: args.domain,
          rationale: args.rationale,
          neuronId: args.neuron_id,
          supersedes: args.supersedes,
          keys: args.keywords,
          keysReplace: args.keywords_replace,
        });
        // Indexing happens inside cortex.learn, through the indexer hook.

        if (result.action === 'skipped_retired' && result.skipped_retired) {
          const r = result.skipped_retired;
          return jsonResult({
            neuron_id: result.neuron?.id ?? null,
            action: 'skipped_retired',
            skipped_retired: r,
            message: `Not stored: this text matches a ${r.status} entry (${r.id}${r.revised ? `, revised ${r.revised}` : ''}). ` +
              (r.note ? `Note: ${r.note}. ` : '') +
              'If it is true again, reactivate it with crbro_revise status active; if you meant a different fact, reword it.',
          });
        }

        // `neuron` is only null when the caller asked not to create one,
        // which the MCP path never does. Guard anyway so the types stay honest.
        if (!result.neuron) {
          return textResult(`No neuron matched "${args.topic}" and none was created.`);
        }

        return jsonResult({
          neuron_id: result.neuron.id,
          action: result.action,
          duplicate: result.duplicate || undefined,
          updated_in_place: result.updated_in_place || undefined,
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
            : result.action === 'skipped'
            ? (result.updated_in_place
                ? `"${result.neuron.name}" already held this ${args.type}; its confidence/keywords were updated in place.`
                : `"${result.neuron.name}" already held this ${args.type} verbatim; nothing added.`)
            : `Updated neuron "${result.neuron.name}" — ${args.type} added` +
              (result.superseded > 0 ? `, ${result.superseded} older fact(s) superseded` : ''),
        });
      } catch (err) {
        return errorResult('learn', err);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 4: crbro_recall — Search the brain
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_recall',
    {
      title: 'Recall',
      description: 'Read-only search of everything saved in earlier sessions — the full text of facts, decisions, patterns, preferences, errors, debts and maps, not just topic names; to read one neuron by id or name use crbro_inspect view=neuron. One result per neuron: its best matching chunk with matched_kind and matched_added, a confidence label (weak = little of the question covered; verify first), plus also_matched. Retired facts and entries never surface. Call it before asking the user what they may already have told you, and before crbro_learn. If nothing matches, retry with 2-4 phrasings in queries or fewer, distinctive words. has_map:true: read the system map with crbro_map before touching that system.',
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
      try {
        const results = await searchEngine.searchMany([args.query, ...(args.queries || [])], {
          domain: args.domain,
          limit: args.limit,
        });

        const payload = {
          query: args.query,
          total_results: results.length,
          results,
          hint: results.length === 0
            ? 'Nothing matched. Try fewer, more distinctive words - names, ids, filenames - rather than a full sentence.'
            : 'matching_content is the chunk that matched; matched_added is when it was recorded; confidence "weak" means little of the question was covered - verify before relying on it. Prefer recent facts when two disagree. has_map: true means the neuron holds a system map - read it with crbro_map before working on that system. To read the whole neuron: crbro_inspect view=neuron.',
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      } catch (err) {
        return errorResult('recall', err);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 5: crbro_revise — Retire, reactivate, edit metadata
  // ═══════════════════════════════════════════════════════════════
  const reviseSchema = z.object({
    neuron: z.string().describe('Neuron id or name holding what to revise, e.g. "project_octochat".'),
    facts: z.array(z.string()).optional().describe('Facts to move to `status`: their ids (from crbro_recall) or exact text (trimmed, case-insensitive). For superseded/retracted only active facts match; for active only retired ones do.'),
    entries: z.array(z.string()).optional().describe('Exact texts of decisions, patterns, errors or debts to move to `status`. Retired entries stay in the file (entry_status) but leave recall like a superseded fact.'),
    status: z.enum(['superseded', 'retracted', 'active']).optional().describe('superseded = a newer truth exists (default); retracted = it was never true; active = reactivate a retired fact or entry. Reactivation is local: on a shared neuron the next sync re-applies the retirement (the response carries shared_warning).'),
    note: z.string().optional().describe('Why. Stored as revision_note on facts and entry_status.note on entries. The next reader will wonder.'),
    summary: z.string().optional().describe('Replace the neuron summary. Credentials are redacted and listed in redacted.'),
    domain: z.string().optional().describe('Replace the neuron domain unconditionally, e.g. "proyectos-web".'),
    tags: z.array(z.string()).optional().describe('Replace the WHOLE tag list (trimmed, deduplicated). On protocol neurons re-send the priority: and source: tags or they are gone.'),
    name: z.string().optional().describe('Rename the neuron. Its id, file, synapses and shared state stay the same.'),
  }).superRefine((v, ctx) => {
    const any = [v.facts, v.entries, v.summary, v.domain, v.tags, v.name].some(x => x !== undefined);
    if (!any) {
      ctx.addIssue({
        code: 'custom',
        message: 'Nothing to revise: pass facts, entries, or a metadata field (summary, domain, tags, name).',
      });
    }
  });

  server.registerTool(
    'crbro_revise',
    {
      title: 'Revise a neuron',
      description: 'Write: change what a neuron says without deleting anything. Stage 2 of the lifecycle: something stopped being true, or was never true, and nothing replaces it → crbro_revise (kept in the file, gone from recall, reversible with status active). If a replacement exists, crbro_learn with supersedes does both; for what must not exist on disk use crbro_forget. facts retires facts by id or exact text; entries retires decisions, patterns, errors and debts by exact text; status active reactivates either (local only on a shared neuron: the next sync re-applies the retirement, shared_warning says so). summary, domain, tags and name edit metadata in the same call (tags replaces the whole list; the id never changes). Anything in unmatched is STILL LIVE — fix and re-run.',
      inputSchema: reviseSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const target = await resolveNeuron(args.neuron);
        if (!target) {
          return textResult(`Neuron not found: "${args.neuron}". Use crbro_recall to find the right neuron id first.`);
        }
        const status = args.status || 'superseded';

        let revisedFacts = 0;
        let revisedEntries = 0;
        const unmatched: string[] = [];
        let changed: string[] = [];
        let redacted: string[] = [];

        if (args.facts && args.facts.length > 0) {
          const r = await cortex.revise(target.id, args.facts, { status, note: args.note });
          revisedFacts = r.revised;
          unmatched.push(...r.unmatched);
        }
        if (args.entries && args.entries.length > 0) {
          const r = await cortex.retireEntries(target.id, args.entries, { status, note: args.note });
          revisedEntries = r.revised;
          unmatched.push(...r.unmatched);
        }
        const meta = { summary: args.summary, domain: args.domain, tags: args.tags, name: args.name };
        if (Object.values(meta).some(v => v !== undefined)) {
          const r = await cortex.setMeta(target.id, meta);
          changed = r.changed;
          redacted = r.redacted;
        }

        const shared = (await sharedMap(brain))[target.id];
        const sharedWarning = status === 'active' && shared
          ? `"${target.id}" is shared in space "${shared}": reactivation is local only — the retirement comes back from the shared log on the next sync.`
          : undefined;

        const parts: string[] = [];
        if (revisedFacts > 0) parts.push(`${revisedFacts} fact(s) ${status === 'active' ? 'reactivated' : 'retired'}`);
        if (revisedEntries > 0) parts.push(`${revisedEntries} entr(y/ies) ${status === 'active' ? 'reactivated' : 'retired'}`);
        if (changed.length > 0) parts.push(`${changed.join(', ')} updated`);
        const touchedTargets = (args.facts?.length ?? 0) + (args.entries?.length ?? 0);

        return jsonResult({
          neuron_id: target.id,
          revised_facts: revisedFacts,
          revised_entries: revisedEntries,
          unmatched: unmatched.length > 0 ? unmatched : undefined,
          changed,
          status,
          shared_warning: sharedWarning,
          redacted: redacted.length > 0 ? redacted : undefined,
          message: parts.length > 0
            ? `${parts.join('; ')} in "${target.name}".` +
              (status !== 'active' && (revisedFacts + revisedEntries) > 0 ? ' They no longer appear in recall.' : '') +
              (unmatched.length > 0 ? ` WARNING: ${unmatched.length} target(s) matched nothing and are unchanged.` : '')
            : touchedTargets > 0
            ? 'Nothing matched. Pass the fact id from crbro_recall, or the exact text; for status active only retired items match.'
            : 'Nothing changed: the metadata already had those values.',
        });
      } catch (err) {
        return errorResult('revise', err);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 6: crbro_forget — Remove from disk, five modes
  // ═══════════════════════════════════════════════════════════════
  const forgetSchema = z.object({
    neuron: z.string().optional().describe('Neuron id or name the mode acts on. Required for every mode except session. restore needs the exact neuron id.'),
    facts: z.array(z.string()).optional().describe('Mode facts: fact ids, or the exact text of a fact, decision, pattern, preference, error or debt; the exact full text of the map removes the map. Deleted for good after a quarantine copy; decision/pattern removals travel to shared spaces like errors and debts.'),
    entire: z.boolean().optional().describe('Mode entire: delete the whole neuron and its synapses. Without confirm_token it is a dry run — { neuron_id, dry_run:true, counts, shared_in, confirm_token }. Refused (no token) while the neuron is shared: crbro_share unshare first.'),
    confirm_token: z.string().optional().describe('Only with entire:true — the token from the dry run. Derived from the neuron\'s counts, so it goes stale (and is refused) when the neuron changed in between.'),
    restore: z.boolean().optional().describe('Mode restore: bring back the newest quarantine copy of `neuron` (exact id). If the neuron exists again, the copy is merged into it (merged_into_existing:true, moved counts). The quarantine file stays, so restore is repeatable.'),
    merge_into: z.string().optional().describe('Mode merge_into: target neuron id or name. Everything of `neuron` is unioned into it, synapses rewired, then `neuron` is deleted (quarantined first). Refused while `neuron` is shared.'),
    session: z.string().optional().describe('Mode session: session id ("session_2026-09-03" or "2026-09-03") whose log is deleted after a quarantine copy. `neuron` is not needed.'),
  }).superRefine((v, ctx) => {
    const modes = [
      v.facts !== undefined ? 'facts' : null,
      v.entire ? 'entire' : null,
      v.restore ? 'restore' : null,
      v.merge_into !== undefined ? 'merge_into' : null,
      v.session !== undefined ? 'session' : null,
    ].filter((m): m is string => m !== null);
    if (modes.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: `Pass exactly ONE mode: facts (entries of a neuron), entire (whole neuron, two steps), restore (from quarantine), merge_into (another neuron) or session (a day log). Got ${modes.length === 0 ? 'none' : modes.join(' + ')}. confirm_token is only valid with entire.`,
      });
    }
    if (v.confirm_token !== undefined && !v.entire) {
      ctx.addIssue({ code: 'custom', path: ['confirm_token'], message: 'confirm_token is only valid with entire:true.' });
    }
    if (v.session === undefined && !v.neuron) {
      ctx.addIssue({ code: 'custom', path: ['neuron'], message: 'neuron (id or name) is required for every mode except session.' });
    }
  });

  const forgetToken = (n: Neuron): string => contentHash(
    `forget:${n.id}:${(n.facts || []).length}:${(n.decisions || []).length}:${(n.patterns || []).length}:${(n.connections || []).length}`, 8);

  server.registerTool(
    'crbro_forget',
    {
      title: 'Forget for good',
      description: 'Write, destructive: remove from disk after a quarantine copy (backup returned). Stage 3 of the lifecycle: something must not exist on disk at all — a credential, personal data, a whole neuron → crbro_forget; for knowledge that merely stopped being true use crbro_revise, which keeps the history. One mode per call. facts: delete entries of a neuron (facts, decisions, patterns, preferences, errors, debts, the map) by id or exact text. entire: delete the whole neuron and its synapses — call it without confirm_token first: the dry run reports what would happen and returns confirm_token. Show the user, get agreement, call again with the token; a stale token is refused. restore: bring back the newest quarantine copy. merge_into: union a neuron into another, rewire synapses, delete the source. session: delete one day\'s log. entire and merge_into refuse a shared neuron — crbro_share unshare first. A removed credential must still be rotated.',
      inputSchema: forgetSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        // ── session ──
        if (args.session !== undefined) {
          const r = await hippocampus.forgetSession(args.session);
          return jsonResult({
            ...r,
            message: r.removed
              ? `Session log ${r.session_id} deleted. A copy is in ${r.backup}.`
              : `No session log called ${r.session_id}. List them with crbro_inspect view=sessions.`,
          });
        }

        const ref = args.neuron as string;

        // ── facts ──
        if (args.facts !== undefined) {
          const r = await cortex.forget(ref, args.facts);
          if (!r.neuron_id) {
            return textResult(`Neuron not found: "${ref}". Use crbro_recall or crbro_audit to find the right one.`);
          }
          return jsonResult({
            neuron_id: r.neuron_id,
            removed: r.removed,
            backup: r.backup,
            message: r.removed > 0
              ? `${r.removed} entr(y/ies) removed from "${r.neuron_id}". A copy of the neuron as it was is in ${r.backup}. ` +
                'If any of them was a credential, rotate it: it existed on disk and in the index.'
              : 'Nothing matched. Pass the fact id from crbro_recall, or its exact text.',
          });
        }

        // ── restore ──
        if (args.restore) {
          const r = await cortex.restoreNeuron(ref);
          if (!r.neuron) {
            return textResult(`No quarantine copy found for neuron id "${ref}". restore needs the exact id the neuron had; names are not resolved here.`);
          }
          return jsonResult({
            neuron_id: r.neuron.id,
            restored_from: r.restored_from,
            merged_into_existing: r.merged_into_existing,
            moved: r.moved,
            message: r.merged_into_existing
              ? `"${r.neuron.name}" existed again, so the quarantine copy was merged into it (see moved). Synapses were not restored: reconnect with crbro_connect if needed.`
              : `"${r.neuron.name}" restored from ${r.restored_from}. Synapses were not restored: reconnect with crbro_connect if needed.`,
          });
        }

        // ── merge_into ──
        if (args.merge_into !== undefined) {
          const from = await resolveNeuron(ref);
          if (!from) return textResult(`Neuron not found: "${ref}".`);
          const into = await resolveNeuron(args.merge_into);
          if (!into) return textResult(`Target neuron not found: "${args.merge_into}".`);
          if (from.id === into.id) {
            return textResult(`"${ref}" and "${args.merge_into}" are the same neuron (${from.id}); nothing to merge.`);
          }
          const shared = (await sharedMap(brain))[from.id];
          if (shared) {
            return textResult(
              `Refused: "${from.id}" is shared in space "${shared}" and would be re-created by the next sync. ` +
              'Take it out first with crbro_share unshare:true, then merge.', true);
          }
          const r = await cortex.mergeNeurons(from.id, into.id);
          if (!r.from || !r.into || !r.moved) {
            return textResult(`Merge did not run: ${!r.from ? `source "${ref}"` : `target "${args.merge_into}"`} could not be resolved.`, true);
          }
          const rewired = await synapses.rewire(from.id, into.id);
          return jsonResult({
            from: r.from,
            into: r.into,
            backup: r.backup,
            moved: r.moved,
            synapses: rewired,
            message: `"${from.name}" merged into "${into.name}" and deleted; a copy is in ${r.backup}. ` +
              `Synapses: ${rewired.moved} moved, ${rewired.merged} merged, ${rewired.dropped} dropped. ` +
              `Undo with crbro_forget restore:true neuron="${from.id}".`,
          });
        }

        // ── entire (two steps) ──
        const target = await resolveNeuron(ref);
        if (!target) return textResult(`Neuron not found: "${ref}".`);
        const shared = (await sharedMap(brain))[target.id];
        const counts = {
          facts: (target.facts || []).length,
          decisions: (target.decisions || []).length,
          patterns: (target.patterns || []).length,
          preferences: (target.preferences || []).length,
          errors: (target.errors || []).length,
          debts: (target.debts || []).length,
          connections: (target.connections || []).length,
        };
        const token = forgetToken(target);

        if (!args.confirm_token) {
          return jsonResult({
            neuron_id: target.id,
            name: target.name,
            dry_run: true,
            counts,
            shared_in: shared ?? null,
            confirm_token: shared ? undefined : token,
            message: shared
              ? `Refused: "${target.id}" is shared in space "${shared}" and would be re-created by the next sync. ` +
                'Take it out first with crbro_share unshare:true, then call again.'
              : `Dry run: deleting "${target.name}" removes ${counts.facts} fact(s), ${counts.decisions} decision(s), ` +
                `${counts.patterns} pattern(s), ${counts.preferences} preference(s), ${counts.errors} error(s), ${counts.debts} debt(s) ` +
                `and ${counts.connections} synapse(s). A quarantine copy is kept (restore:true brings it back). ` +
                'Show this to the user; with their agreement call again with confirm_token.',
          });
        }

        if (shared) {
          return textResult(
            `Refused: "${target.id}" is shared in space "${shared}". Take it out first with crbro_share unshare:true.`, true);
        }
        if (args.confirm_token !== token) {
          return textResult(
            `Stale confirm_token: "${target.id}" changed since the dry run. Call again without the token to get a fresh one.`, true);
        }

        const r = await cortex.forgetNeuron(target.id);
        if (!r.neuron_id) return textResult(`Neuron not found: "${ref}".`);
        const synapsesRemoved = await synapses.removeAllFor(target.id);
        return jsonResult({
          neuron_id: r.neuron_id,
          removed: 'neuron',
          backup: r.backup,
          counts: r.counts,
          synapses_removed: synapsesRemoved,
          message: `"${target.name}" deleted with ${synapsesRemoved} synapse(s). A copy is in ${r.backup}; ` +
            `crbro_forget restore:true neuron="${target.id}" brings it back. If it held a credential, rotate it.`,
        });
      } catch (err) {
        return errorResult('forget', err);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 7: crbro_connect — Create, strengthen or delete a synapse
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_connect',
    {
      title: 'Connect two neurons',
      description: 'Write: create, strengthen or delete the undirected synapse between two neurons; both ids are validated. action=connect (default) creates at strength 0.5 and adds +0.1 per repeat call (cap 1.0), or sets the absolute strength you pass; action=disconnect deletes the synapse and unlinks both neurons — the destructive side. Idle synapses decay and crbro_maintenance prunes the weak; crbro_consolidate links neurons written in the same session by itself, so use this for relationships beyond co-occurrence. To read connections use crbro_inspect view=neuron. Returns synapse_id, action (created|strengthened|disconnected|absent) and strength.',
      inputSchema: {
        action: z.enum(['connect', 'disconnect']).optional().describe('connect = create or strengthen (default); disconnect = delete the synapse and unlink both neurons. An absent synapse returns action:absent, removed:false, not an error.'),
        from: z.string().describe('Exact neuron id, e.g. "project_octochat". Validated: an unknown id is an error.'),
        to: z.string().describe('Exact neuron id. Order does not matter — (a,b) and (b,a) are the same synapse.'),
        type: z.enum(['dependency', 'causal', 'temporal', 'conceptual', 'hierarchy', 'alternative']).optional().describe('Relationship kind, used only when the synapse is created (default conceptual). Ignored on strengthen and on disconnect.'),
        strength: z.number().min(0).max(1).optional().describe('Absolute strength 0.0-1.0 to set, on create or on an existing synapse, instead of the 0.5 / +0.1 rule.'),
        context: z.string().optional().describe('One line on the relationship. On strengthen it replaces the stored text; omit to keep it.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        for (const id of [args.from, args.to]) {
          if (!(await cortex.peek(id))) {
            return textResult(`Unknown neuron: ${id}. Pass exact ids — find them with crbro_recall or crbro_inspect view=neurons.`, true);
          }
        }

        if (args.action === 'disconnect') {
          const r = await synapses.disconnect(args.from, args.to);
          return jsonResult({
            synapse_id: r.synapse_id,
            action: r.removed ? 'disconnected' : 'absent',
            removed: r.removed,
            message: r.removed
              ? `Synapse removed: ${args.from} ↔ ${args.to}. Both neurons no longer list each other.`
              : `No synapse between ${args.from} and ${args.to}; nothing to remove.`,
          });
        }

        const type = args.type ?? 'conceptual';
        const result = await synapses.connect(args.from, args.to, type, args.context, { strength: args.strength });
        return jsonResult({
          synapse_id: result.synapse.id,
          action: result.action,
          strength: result.synapse.strength,
          message: result.action === 'created'
            ? `New synapse: ${args.from} ↔ ${args.to} (${type}) at strength ${result.synapse.strength}`
            : `Synapse strengthened: ${args.from} ↔ ${args.to} → strength ${result.synapse.strength}`,
        });
      } catch (err) {
        return errorResult('connect', err);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 8: crbro_context — Active context
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_context',
    {
      title: 'Working context',
      description: 'Read or write the working context: active topics, open items, recently closed, last session. Called with no arguments it only reads (written:false, nothing touched); any argument writes and returns the full state plus resolved and discarded. Close items as soon as they are done — resolve_pending records them in recently_closed, discard_pending drops one without recording it, clear empties everything — because an item left open is repeated back to the user in later sessions long after it was finished. Sessions are logged by crbro_consolidate, not here.',
      inputSchema: {
        set_topics: z.array(z.string()).optional().describe('Replace the whole active-topics list with these neuron ids (no merge). crbro_consolidate also rewrites it from the session.'),
        add_pending: z.string().optional().describe('Add an open item, written so it can be checked later. Identical text is deduplicated, so re-adding is a safe no-op.'),
        resolve_pending: z.string().optional().describe('Close an open item by id (e.g. "p_ab12cd") or by 8+ characters of its text (case-insensitive substring; several items can close at once). Matches move to recently_closed, newest first, capped at 15. An empty resolved in the reply means nothing matched.'),
        discard_pending: z.string().optional().describe('Drop an open item by id or 8+ characters of its text WITHOUT recording it as done (it never appears in recently_closed). Same matcher as resolve_pending; matches come back in discarded.'),
        clear: z.boolean().optional().describe('Empty active_topics, pending_tasks and recently_closed. Runs before the other updates in the same call.'),
      },
      // clear empties the whole working context and discard_pending drops an
      // item without recording it: destructive, whatever the common path does.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const ctx = await prefrontal.updateContext({
          set_topics: args.set_topics,
          add_pending: args.add_pending,
          resolve_pending: args.resolve_pending,
          discard_pending: args.discard_pending,
          clear: args.clear,
        });
        return jsonResult(ctx);
      } catch (err) {
        return errorResult('context', err);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 9: crbro_map — The living map of a system
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_map',
    {
      title: 'System map',
      description: 'Read or replace a neuron\'s system map: ONE living document — where the system lives, what serves what, which pieces talk to each other, the traps that cost hours. crbro_inspect view=neuron already returns the map; use crbro_map to read it alone, or to rewrite it. Omit content to read (map:null if none); content replaces the previous version entirely (append-only maps rot); an empty string clears it. Read it before working on a system touched in past sessions; after changing the system rewrite the whole map. Reading never creates a neuron, writing does. Credentials are redacted on write. Atomic facts belong in crbro_learn — the map is the prose around them.',
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
          const neuron = await resolveNeuron(args.neuron);
          if (!neuron) {
            return textResult(`Neuron not found: "${args.neuron}". Use crbro_recall to find the right neuron id first.`);
          }
          if (!neuron.map || !neuron.map.text) {
            return jsonResult({
              neuron_id: neuron.id,
              map: null,
              message: `"${neuron.name}" has no system map yet. After working on this system, write one with crbro_map + content: where it lives, what serves what, the traps.`,
            });
          }
          return jsonResult({
            neuron_id: neuron.id,
            updated: neuron.map.updated,
            by: neuron.map.by,
            map: neuron.map.text,
            hint: 'If anything here proved wrong or the system changed, rewrite the map before closing the task.',
          });
        }

        const result = await cortex.setMap(args.neuron, args.content, {
          domain: args.domain,
        });
        if (!result.neuron) {
          return textResult(`Could not store the map for "${args.neuron}".`);
        }
        return jsonResult({
          neuron_id: result.neuron.id,
          action: result.action,
          updated: result.neuron.map?.updated,
          length: args.content.length,
          redacted: result.redacted.length > 0 ? result.redacted : undefined,
          message: args.content.trim() === ''
            ? `System map of "${result.neuron.name}" cleared.`
            : `System map of "${result.neuron.name}" replaced. The previous version is gone - this one is now the reference.`,
        });
      } catch (err) {
        return errorResult('map', err);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 10: crbro_consolidate — End-of-session consolidation
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_consolidate',
    {
      title: 'Consolidate the session',
      description: 'Write: close the session — the only way to log a session. Call it before the conversation ends. Persists pending knowledge and index writes, logs the session from summary (credentials stripped, kinds in redacted), sets the context\'s last_session, recalculates heat, links the neurons written this session with weak temporal synapses (synapses_updated), updates the manifest and syncs shared team spaces (offline is normal). Returns session_id, facts_saved, decisions_saved, topics_touched and per-space sync state; topics_touched logs neurons you only read. Not consolidating loses the session\'s knowledge. Mid-session open items go to crbro_context; housekeeping is crbro_maintenance.',
      inputSchema: {
        summary: z.string().describe('What was accomplished: concrete work, decisions, outcomes. Stored (after credential redaction) as the session log later sessions read.'),
        topics_touched: z.array(z.string()).optional().describe('Neuron ids this session used WITHOUT writing (recalled, inspected, discussed). Added to the log\'s topics_touched next to the ids written this session; write counters stay real. Unknown ids are dropped and listed in topics_unknown.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await maintenance.consolidate(args.summary, { topicsTouched: args.topics_touched });
        // Flush any index writes still sitting in the debounce window, so a
        // session that ends right after a learn does not lose it.
        await searchEngine.flush();
        // Send the session's notes to the team before the lights go out.
        const compartidos = await syncAll(brain, cortex, 10_000);

        return jsonResult({
          ...result,
          shared_spaces: compartidos.length > 0
            ? compartidos.map(c => ({ space: c.space, state: c.state, pushed: c.pushed }))
            : undefined,
          message: 'Session consolidated. Brain state persisted.',
        });
      } catch (err) {
        return errorResult('consolidate', err);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 11: crbro_maintenance — Run maintenance
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_maintenance',
    {
      title: 'Brain maintenance',
      description: 'Write: brain housekeeping — recalculate heat, prune weak synapses, check integrity, rebuild the search index. Returns a report (counts, integrity_issues, repairable, notes) and flags debts without a revisit trigger. dry_run:true writes nothing at all (the global map is computed live, never cached). Extras are OFF unless asked: archive cold neurons (on a mature brain most look cold, and archived ones stop being searchable), unarchive them back, purge_boilerplate left by early miners, repair what the integrity check found. For session close use crbro_consolidate; to only read the brain use crbro_inspect.',
      inputSchema: {
        dry_run: z.boolean().optional().describe('true = report only: no heat recalc, archiving, unarchiving, purge, repair, lock sweep, pruning or index rebuild, and no file written. Counts, debts and integrity checks still run.'),
        archive: z.boolean().optional().describe('Also move cold neurons (heat < 0.05, untouched 90+ days) out of the cortex into archives/. Off by default; run dry_run first and read archivable_neurons. Undo with unarchive.'),
        unarchive: z.union([z.array(z.string()), z.literal('all')]).optional().describe('Move these neuron ids (or "all") from archives/ back into the cortex and reindex them. Off in dry_run; the report says archives_count and unarchived_neurons; unknown ids are listed in notes.'),
        purge_boilerplate: z.boolean().optional().describe('Also delete contentless facts left by early miner versions ("Referenced in: file.md"). Off by default; every run reports how many there are. Neurons left empty are kept.'),
        repair: z.boolean().optional().describe('Fix what the integrity check found: dangling connection ids, synapse files pointing at missing neurons, entry_dates/entry_status keys with no live entry, manifest counters. Off in dry_run; the report lists repairs[] one line each.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const report = await maintenance.run(args.dry_run, {
          archive: args.archive,
          purgeBoilerplate: args.purge_boilerplate,
          repair: args.repair,
          unarchive: args.unarchive,
        });

        return jsonResult({
          mode: args.dry_run ? 'DRY RUN' : 'EXECUTED',
          ...report,
        });
      } catch (err) {
        return errorResult('maintenance', err);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 12: crbro_audit — What should not be in the brain
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_audit',
    {
      title: 'Audit for credentials',
      description: 'Read-only scan of every field of every neuron (facts, decisions, patterns, preferences, errors, debts, system map) and of every session log for credentials stored before the filter caught them — API keys, tokens, passwords. Reports where they sit and what kind, never the values. Findings are in the search index too, so recall can return them: remove with crbro_forget (facts for entries, session for a day log), then rotate the credential. Run it after upgrading and whenever a secret may have been pasted into a conversation. crbro_inspect shows content; this only judges it.',
      inputSchema: {},
      outputSchema: {
        neurons_affected: z.number(),
        facts_affected: z.number(),
        findings: z.array(z.object({
          neuron_id: z.string(), name: z.string(), kinds: z.array(z.string()),
          facts: z.number(), decisions: z.number(), patterns: z.number(), preferences: z.number(),
          errors: z.number(), debts: z.number(), map: z.number(),
        }).loose()),
        sessions_affected: z.number().optional(),
        session_findings: z.array(z.object({
          session_id: z.string(), date: z.string(), kinds: z.array(z.string()),
        }).loose()).optional(),
        message: z.string(),
        note: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const hallazgos = await cortex.auditSecrets();
        const sesiones = await hippocampus.auditSecrets();
        const total = hallazgos.reduce(
          (n, h) => n + h.facts + h.decisions + h.patterns + h.preferences + h.errors + h.debts + h.map, 0);

        const clean = hallazgos.length === 0 && sesiones.length === 0;
        const payload = {
          neurons_affected: hallazgos.length,
          facts_affected: total,
          findings: hallazgos,
          sessions_affected: sesiones.length,
          session_findings: sesiones,
          message: clean
            ? 'No credentials found in the brain or in the session logs.'
            : (hallazgos.length > 0
                ? `${total} entr(y/ies) across ${hallazgos.length} neuron(s) contain something that looks like a credential. ` +
                  'They are also inside the search index, so recall can return them. Remove them with crbro_forget facts. '
                : '') +
              (sesiones.length > 0
                ? `${sesiones.length} session log(s) contain something that looks like a credential; remove each with crbro_forget session. `
                : '') +
              'Then rotate the credentials — assume they are compromised.',
          note: 'Values are never shown here, by design.',
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      } catch (err) {
        return errorResult('audit', err);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 13: crbro_secret — Credentials, brokered to the OS keychain
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_secret',
    {
      title: 'Keychain secret',
      description: 'Read or write credentials in the operating system\'s keychain (macOS Keychain, Linux Secret Service, Windows DPAPI): CRBRO keeps no copy, invents no crypto, and no sync or team space can reach the store. When the user hands you a credential, set it here, then record only the NAME with crbro_learn. get returns the value for the task at hand — an environment variable of the same name wins; a missing secret returns found:false, not an error — never print it back unless the user asked. list returns names only; remove deletes one; status says which store this machine has (none is a normal answer; env vars still work). Names are SCREAMING_SNAKE_CASE; set updates in place and rejects empty values.',
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

        return jsonResult(payload);

      } catch (err) {
        return textResult(
          err instanceof KeychainUnavailable
            ? `No credential store available: ${err.message}`
            : `CRBRO secret error: ${err instanceof Error ? err.message : String(err)}`,
          true);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 14: crbro_space — A team's shared memory
  // ═══════════════════════════════════════════════════════════════
  server.registerTool(
    'crbro_space',
    {
      title: 'Team space',
      description: 'Read or write team spaces — shared memory with teammates: a private git repository holding notes about the projects you choose to share; nothing else from your brain goes near it. create starts one (name, remote, author); join clones one a teammate created; status reads your identity and spaces; sync exchanges notes now — the manual form of what crbro_boot and crbro_consolidate do alone, useful right after crbro_share (offline is a normal answer, not a failure); leave pushes pending notes, deletes the local copy and stops following its neurons (neurons untouched). Joining shares nothing: put each project in with crbro_share. create and join reply ok:false with the reason on failure.',
      inputSchema: {
        action: z.enum(['create', 'join', 'status', 'sync', 'leave']).describe('create = start a new space and push it; join = clone one a teammate created; status = your identity and spaces; sync = exchange notes now; leave = sync, then forget the space locally.'),
        name: z.string().optional().describe('Short name, e.g. "equipo" — the same on everyone\'s machine. Required for create, join and leave; optional for sync (omit = every space); ignored for status.'),
        remote: z.string().optional().describe('Git URL of a private repository — EMPTY for create, the same URL the creator used for join. E.g. git@github.com:acme/team-memory.git.'),
        author: z.string().optional().describe('How your notes are signed, e.g. "ana". Lowercase, no spaces. Required for create and join.'),
        branch: z.string().optional().describe('Branch to use (default "main"). create and join only.'),
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
          return jsonResult({
            you_are: id.author,
            device: id.device,
            spaces: detalle,
            message: detalle.length === 0
              ? 'You are not in any shared space. Use action "create" to start one, or "join" if a teammate already did.'
              : `In ${detalle.length} space(s). They sync automatically at boot and on consolidate; action "sync" does it now.`,
          });
        }

        if (args.action === 'sync') {
          const informes = args.name
            ? [await syncSpaceNow(brain, cortex, args.name, 30_000)]
            : await syncAll(brain, cortex, 30_000);

          if (informes.length === 0) {
            return textResult('You are not in any shared space yet. Use action "create" or "join" first.');
          }

          return jsonResult({
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
          });
        }

        if (args.action === 'leave') {
          if (!args.name) {
            return textResult('name is required for leave: which space to leave.');
          }
          const r = await leaveSpace(brain, cortex, args.name);
          return jsonResult({
            ...r,
            next: r.ok
              ? 'Your neurons are intact and no longer followed; the remote repository was not touched. Re-join later with action "join" and the same URL.'
              : undefined,
          });
        }

        if (!args.name || !args.remote) {
          return textResult('Both name and remote are required for create and join.');
        }
        if (!args.author) {
          return textResult('Pass author so your notes carry your name, e.g. author: "ana".');
        }

        const r = args.action === 'create'
          ? await createSpace(brain, args.name, args.remote, args.author, args.branch || 'main')
          : await joinSpace(brain, args.name, args.remote, args.author, args.branch || 'main');

        return jsonResult({
          ok: r.ok,
          message: r.message,
          detail: r.detail,
          next: r.ok && args.action === 'create'
            ? 'Now share a project into it with crbro_share, and invite your teammates to the repository.'
            : r.ok
            ? 'Run crbro_space action=sync to pull in what the others already know.'
            : undefined,
        });
      } catch (err) {
        return errorResult('space', err);
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // TOOL 15: crbro_share — Put one project into a space, or take it out
  // ═══════════════════════════════════════════════════════════════
  const shareSchema = z.object({
    neuron: z.string().describe('Neuron id or name to share or unshare.'),
    space: z.string().optional().describe('Space name, as created or joined with crbro_space. Required unless unshare:true.'),
    confirm: z.string().optional().describe('The confirm_token from the dry run — returned only when no credential was found. Omit the first time. Ignored with unshare.'),
    unshare: z.boolean().optional().describe('Stop following `neuron` in its space: no more notes go out, the next sync ignores it, and the neuron can then be forgotten. Already-sent notes stay in the remote and in teammates\' brains. space and confirm are ignored in this mode.'),
  }).superRefine((v, ctx) => {
    if (!v.unshare && !v.space) {
      ctx.addIssue({ code: 'custom', path: ['space'], message: 'space is required unless unshare:true.' });
    }
  });

  server.registerTool(
    'crbro_share',
    {
      title: 'Share a project',
      description: 'Write: put one neuron into a team space, or take it out with unshare. Call it without confirm first: the dry run reports what would be sent — ops_to_emit, skipped_preferences (preferences never leave this machine) — and refuses outright if it finds a credential (crbro_forget it and rotate it). Show the user, get agreement, call again with the confirm token; a stale token is refused. Entries go out on the next crbro_space action=sync or consolidate, and from then on everything learned about that project flows to the team. unshare stops future notes; what was already sent stays in the remote and in teammates\' brains. Spaces are managed with crbro_space.',
      inputSchema: shareSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        if (args.unshare) {
          const r = await unshareNeuron(brain, cortex, args.neuron);
          return jsonResult({
            ...r,
            next: r.ok
              ? 'No more notes go out for this neuron. What was already sent stays in the remote and in teammates\' brains. It can now be forgotten or merged with crbro_forget.'
              : undefined,
          });
        }

        const space = args.space as string;
        if (!args.confirm) {
          const prep = await prepareShare(brain, cortex, args.neuron, space);
          if ('error' in prep) {
            return textResult(prep.error);
          }
          return jsonResult({
            ...prep,
            message: prep.blocked.length > 0
              ? `Refused: ${prep.blocked.length} credential(s) found in this neuron. Nothing was sent. ` +
                'Remove them with crbro_forget and rotate them, then try again.'
              : `Ready to share ${prep.ops_to_emit} entries. ${prep.skipped_preferences} preference(s) will NOT be sent — ` +
                'preferences never leave this machine. Show the user what is about to be shared, then call again with the confirm token.',
          });
        }

        const r = await commitShare(brain, cortex, args.neuron, space, args.confirm);
        return jsonResult({
          ...r,
          next: r.ok ? 'Run crbro_space action=sync to send it now, or let it go out on the next consolidate. unshare:true stops future notes.' : undefined,
        });
      } catch (err) {
        return errorResult('share', err);
      }
    }
  );

  return server;
}
