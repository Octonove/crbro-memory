// ─── CRBRO Types ─────────────────────────────────────────────────
// Biological neural memory architecture types

// ─── Cortex (Knowledge Nodes) ────────────────────────────────────

export interface Fact {
  text: string;
  confidence: number;       // 0.0 - 1.0
  added: string;             // ISO date
  source: string;            // session_id or manual
}

export interface Decision {
  text: string;
  date: string;              // ISO date
  rationale: string;
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

export interface ActiveContext {
  last_session: string;
  active_topics: string[];   // neuron IDs
  pending_tasks: string[];
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
  message: string;
}

// ─── Search Result ───────────────────────────────────────────────

export interface SearchResult {
  neuron_id: string;
  name: string;
  domain: string;
  relevance_score: number;
  matching_content: string;
  heat: number;
}
