// ─── CRBRO Prefrontal Engine ─────────────────────────────────────
// Active context, hot topics, and global map (clustering + bridges)

import { readJSON, writeJSON, listJSONFiles, now } from '../utils/fs.js';
import type { Brain } from './brain.js';
import type { ActiveContext, HotTopics, GlobalMap, Cluster, Bridge, Neuron } from '../types/index.js';

export class Prefrontal {
  constructor(private brain: Brain) {}

  // ─── Active Context ────────────────────────────────────────────

  /**
   * Get the current active context.
   */
  async getContext(): Promise<ActiveContext> {
    const ctx = await readJSON<ActiveContext>(this.brain.paths.activeContext());
    return ctx || {
      last_session: '',
      active_topics: [],
      pending_tasks: [],
      last_updated: now(),
    };
  }

  /**
   * Update the active context.
   */
  async updateContext(updates: {
    set_topics?: string[];
    add_pending?: string;
    resolve_pending?: string;
  }): Promise<ActiveContext> {
    const ctx = await this.getContext();

    if (updates.set_topics) {
      ctx.active_topics = updates.set_topics;
    }

    if (updates.add_pending) {
      if (!ctx.pending_tasks.includes(updates.add_pending)) {
        ctx.pending_tasks.push(updates.add_pending);
      }
    }

    if (updates.resolve_pending) {
      ctx.pending_tasks = ctx.pending_tasks.filter(t => t !== updates.resolve_pending);
    }

    ctx.last_updated = now();
    await writeJSON(this.brain.paths.activeContext(), ctx);
    return ctx;
  }

  // ─── Hot Topics ─────────────────────────────────────────────────

  /**
   * Get current hot topics.
   */
  async getHotTopics(limit: number = 15): Promise<HotTopics> {
    const ht = await readJSON<HotTopics>(this.brain.paths.hotTopics());
    if (!ht) {
      return { topics: [], last_recalculated: now() };
    }
    return {
      ...ht,
      topics: ht.topics.slice(0, limit),
    };
  }

  // ─── Global Map (Premium Feature) ──────────────────────────────

  /**
   * Build the global map — clusters of related neurons and bridges between domains.
   */
  async buildGlobalMap(): Promise<GlobalMap> {
    const ids = await listJSONFiles(this.brain.paths.cortex);
    const neurons: Neuron[] = [];

    for (const id of ids) {
      const neuron = await readJSON<Neuron>(this.brain.paths.neuron(id));
      if (neuron) neurons.push(neuron);
    }

    // Build clusters by domain
    const domainGroups: Record<string, Neuron[]> = {};
    for (const neuron of neurons) {
      const domain = neuron.domain || 'uncategorized';
      if (!domainGroups[domain]) domainGroups[domain] = [];
      domainGroups[domain].push(neuron);
    }

    const clusters: Cluster[] = [];
    for (const [domain, domainNeurons] of Object.entries(domainGroups)) {
      const avgHeat = domainNeurons.reduce((sum, n) => sum + n.heat, 0) / domainNeurons.length;
      clusters.push({
        name: domain,
        nodes: domainNeurons.map(n => n.id),
        summary: `${domainNeurons.length} neurons — top: ${domainNeurons
          .sort((a, b) => b.heat - a.heat)
          .slice(0, 3)
          .map(n => n.name)
          .join(', ')}`,
        heat: Math.round(avgHeat * 1000) / 1000,
      });
    }

    // Find bridges — neurons that connect different domains
    const bridges: Bridge[] = [];
    for (const neuron of neurons) {
      if (neuron.connections.length === 0) continue;

      // Get connected neurons' domains
      const connectedDomains: Set<string> = new Set();
      const viaNodes: string[] = [];

      for (const connId of neuron.connections) {
        const connNeuron = neurons.find(n => n.id === connId);
        if (connNeuron && connNeuron.domain !== neuron.domain) {
          connectedDomains.add(connNeuron.domain);
          viaNodes.push(connId);
        }
      }

      if (connectedDomains.size > 0) {
        for (const targetDomain of connectedDomains) {
          // Avoid duplicate bridges
          const existingBridge = bridges.find(
            b => (b.from === neuron.domain && b.to === targetDomain) ||
                 (b.from === targetDomain && b.to === neuron.domain)
          );

          if (!existingBridge) {
            bridges.push({
              from: neuron.domain,
              to: targetDomain,
              via: viaNodes.filter(v => {
                const n = neurons.find(nn => nn.id === v);
                return n && n.domain === targetDomain;
              }),
              context: `Connected through ${neuron.name}`,
            });
          }
        }
      }
    }

    const globalMap: GlobalMap = {
      last_rebuilt: now(),
      clusters: clusters.sort((a, b) => b.heat - a.heat),
      bridges,
    };

    await writeJSON(this.brain.paths.globalMap(), globalMap);
    return globalMap;
  }

  /**
   * Get the current global map (read from cache, or build if missing).
   */
  async getGlobalMap(rebuild: boolean = false): Promise<GlobalMap> {
    if (rebuild) {
      return this.buildGlobalMap();
    }

    const existing = await readJSON<GlobalMap>(this.brain.paths.globalMap());
    if (existing) return existing;

    return this.buildGlobalMap();
  }
}
