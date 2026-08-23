// ─── CRBRO Types ─────────────────────────────────────────────────
// Biological neural memory architecture types

// ─── Cortex (Knowledge Nodes) ────────────────────────────────────

/**
 * A fact's lifecycle.
 *  - `active`     — current truth (the default; absent means active).
 *  - `superseded` — there is a newer fact that replaces this one.
 *  - `retracted`  — it was never true. Different from superseded on purpose:
 *                   "the price changed" and "I got the price wrong" are not
 *                   the same thing, and the distinction costs nothing.
 */
export type FactStatus = 'active' | 'superseded' | 'retracted';

export interface Fact {
  text: string;
  confidence: number;       // 0.0 - 1.0
  added: string;             // ISO date
  source: string;            // session_id, 'manual' or 'miner'

  // ─── Lifecycle (all optional: a v1 fact is a valid v2 fact) ───
  id?: string;               // content hash, stable across rewrites
  status?: FactStatus;       // absent === 'active'
  supersedes?: string[];     // ids of facts this one replaces
  superseded_by?: string;    // id of the fact that replaced this one
  revised?: string;          // ISO date of the status change
  revision_note?: string;    // why it stopped being true
}

export interface Decision {
  text: string;
  date: string;              // ISO date
  rationale: string;

  // ─── Shared memory (optional: a v1 decision is a valid v2 decision) ───
  /** Content hash, so the same decision from two people lines up. */
  id?: string;
  /** Who recorded it, when it arrived from a teammate. */
  by?: string;
}

export type NeuronType = 'project' | 'tech' | 'lang' | 'person' | 'domain' | 'process' | 'protocol';

export interface Neuron {
  id: string;                // "project_octochat"
  name: string;              // "OctoChat"
  domain: string;            // "proyectos-web"
  type: NeuronType;
  created: string;           // ISO date
  last_accessed: string;     // ISO date
  access_count: number;
  heat: number;              // 0.0 - 1.0
  summary: string;
  facts: Fact[];
  decisions: Decision[];
  patterns: string[];
  preferences: string[];
  connections: string[];     // IDs of connected neurons
  tags: string[];
  /**
   * Mistakes made working on this topic, each with how it was corrected.
   * A separate ledger from patterns so "check my known errors before doing
   * this again" is a real question the brain can answer.
   */
  errors?: string[];
  /**
   * The living map of the system: where it lives, what serves what, which
   * pieces talk to each other, the traps. One document, replaced whole on
   * every update — never appended — so it cannot drift into versions.
   */
  map?: NeuronMap;
}

export interface NeuronMap {
  text: string;
  updated: string;           // ISO date of the last replacement
  by?: string;               // team author, when it arrived through a space
}

// ─── Synapses (Connections) ──────────────────────────────────────

export type SynapseType = 'dependency' | 'causal' | 'temporal' | 'conceptual' | 'hierarchy' | 'alternative';

export interface Synapse {
  id: string;                // "syn_octochat__firebase"
  nodes: [string, string];
  strength: number;          // 0.0 - 1.0
  type: SynapseType;
  context: string;
  co_access_count: number;
  last_co_access: string;    // ISO date
}

// ─── Hippocampus (Sessions) ──────────────────────────────────────

export interface SessionLog {
  session_id: string;        // "session_2026-05-06"
  date: string;              // ISO date
  duration_estimate: string;
  topics_touched: string[];  // neuron IDs
  summary: string;
  key_facts_added: number;
  decisions_made: number;
  new_neurons_created: number;
  synapses_updated: number;
}

// ─── Prefrontal (Working Memory) ─────────────────────────────────

/**
 * A pending item. Addressed by short id because resolving by exact string
 * match was unusable: real pending notes run to hundreds of characters with
 * quotes and paths inside, and no caller ever reproduced one byte-for-byte.
 */
export interface PendingTask {
  id: string;                // "p_ab12cd"
  text: string;
  added: string;             // ISO datetime
  closed?: string;           // ISO datetime, set when resolved
}

export interface ActiveContext {
  last_session: string;
  active_topics: string[];   // neuron IDs
  /** Open items. Strings are still accepted on read for v1 brains. */
  pending_tasks: Array<PendingTask | string>;
  /** Recently resolved items, newest first. Capped — this is a reminder, not a log. */
  recently_closed?: PendingTask[];
  last_updated: string;      // ISO datetime
}

export interface HotTopic {
  id: string;
  name: string;
  heat: number;
  last_access: string;
  domain: string;
}

export interface HotTopics {
  topics: HotTopic[];
  last_recalculated: string;
}

export interface Cluster {
  name: string;
  nodes: string[];
  summary: string;
  heat: number;
}

export interface Bridge {
  from: string;
  to: string;
  via: string[];
  context: string;
}

export interface GlobalMap {
  last_rebuilt: string;
  clusters: Cluster[];
  bridges: Bridge[];
}

// ─── Manifest ────────────────────────────────────────────────────

export interface Manifest {
  version: string;
  created: string;
  owner: string;
  brain_path: string;
  total_neurons: number;
  total_synapses: number;
  total_sessions: number;
  last_boot: string | null;
  last_consolidation: string | null;
}

// ─── Boot Result ─────────────────────────────────────────────────

export interface ProtocolDirective {
  id: string;
  name: string;
  priority: number;      // 1-10, higher = more important
  instructions: string;  // The actual enforcement text
  source: string;        // "zero-deck", "strategy-deck", etc.
}

export interface BootResult {
  status: 'ok' | 'initialized' | 'error';
  total_neurons: number;
  total_synapses: number;
  total_sessions: number;
  hot_topics: HotTopic[];
  last_session: string | null;
  active_context: ActiveContext | null;
  active_protocols: ProtocolDirective[];
  /** Open items, so a fresh session does not have to rediscover them. */
  open_items?: PendingTask[];
  /** Items closed recently, so a stale to-do list is not repeated back. */
  recently_closed?: PendingTask[];
  message: string;
}

// ─── Search Result ───────────────────────────────────────────────

export interface SearchResult {
  neuron_id: string;
  name: string;
  domain: string;
  relevance_score: number;
  /** The chunk that actually matched — not the neuron summary. */
  matching_content: string;
  /** What kind of chunk matched: header | fact | decision | pattern | preference | error | map. */
  matched_kind?: string;
  /** When that chunk was recorded, so callers can prefer recent knowledge. */
  matched_added?: string;
  heat: number;
  /** The neuron keeps a system map — read it with crbro_map before working on this system. */
  has_map?: boolean;
}
