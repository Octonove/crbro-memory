// ─── CRBRO Prefrontal Engine ─────────────────────────────────────
// Active context, hot topics, and global map (clustering + bridges)

import { readJSON, writeJSON, listJSONFiles, now } from '../utils/fs.js';
import { pendingId } from '../utils/hash.js';
import type { Brain } from './brain.js';
import type { ActiveContext, HotTopics, GlobalMap, Cluster, Bridge, Neuron, PendingTask } from '../types/index.js';

/** How many resolved items to keep around as a reminder. */
const RECENTLY_CLOSED_CAP = 15;

/** Normalise a stored entry: v1 brains hold plain strings. */
function toTask(entry: PendingTask | string): PendingTask {
  if (typeof entry === 'string') {
    return { id: pendingId(entry), text: entry, added: '' };
  }
  return entry;
}

export class Prefrontal {
  constructor(private brain: Brain) {}

  // ─── Active Context ────────────────────────────────────────────

  /**
   * Get the current active context.
   */
  async getContext(): Promise<ActiveContext> {
    const ctx = await readJSON<ActiveContext>(this.brain.paths.activeContext());
    if (!ctx) {
      return {
        last_session: '',
        active_topics: [],
        pending_tasks: [],
        recently_closed: [],
        last_updated: now(),
      };
    }
    // Upgrade v1 string entries in memory; they get written back on next update.
    ctx.pending_tasks = (ctx.pending_tasks || []).map(toTask);
    ctx.recently_closed = ctx.recently_closed || [];
    return ctx;
  }

  /**
   * Update the active context.
   */
  async updateContext(updates: {
    set_topics?: string[];
    add_pending?: string;
    /**
     * Id of the item to close, or enough of its text to identify it.
     *
     * This used to filter by exact string equality, which made real pending
     * items unresolvable: they run to hundreds of characters with quotes and
     * file paths inside, and nothing ever reproduced one byte-for-byte. So
     * items accumulated forever and got repeated back to the user long after
     * they were done.
     */
    resolve_pending?: string;
  }): Promise<ActiveContext & { resolved?: PendingTask[] }> {
    const ctx = await this.getContext();
    const tasks = ctx.pending_tasks.map(toTask);
    let resolved: PendingTask[] = [];

    if (updates.set_topics) {
      ctx.active_topics = updates.set_topics;
    }

    if (updates.add_pending) {
      const text = updates.add_pending.trim();
      const id = pendingId(text);
      if (!tasks.some(t => t.id === id)) {
        tasks.push({ id, text, added: now() });
      }
    }

    if (updates.resolve_pending) {
      const needle = updates.resolve_pending.trim();
      const lower = needle.toLowerCase();

      const hit = (t: PendingTask) =>
        t.id === needle ||
        t.text === needle ||
        (lower.length >= 8 &&
          (t.text.toLowerCase().includes(lower) || lower.includes(t.text.toLowerCase())));

      resolved = tasks.filter(hit).map(t => ({ ...t, closed: now() }));
      const keep = tasks.filter(t => !hit(t));

      if (resolved.length > 0) {
        ctx.recently_closed = [...resolved, ...(ctx.recently_closed || [])]
          .slice(0, RECENTLY_CLOSED_CAP);
      }
      ctx.pending_tasks = keep;
    } else {
      ctx.pending_tasks = tasks;
    }

    ctx.last_updated = now();
    await writeJSON(this.brain.paths.activeContext(), ctx);
    return { ...ctx, resolved };
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

  // ─── Global Map ────────────────────────────────────────────────

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
