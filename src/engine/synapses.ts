// ─── CRBRO Synapses Engine ───────────────────────────────────────
// Connection management between neurons with strength decay

import { readJSON, writeJSON, listJSONFiles, now } from '../utils/fs.js';
import { synapseId } from '../utils/ids.js';
import type { Brain } from './brain.js';
import type { Synapse, SynapseType, Neuron } from '../types/index.js';

export class Synapses {
  constructor(private brain: Brain) {}

  /**
   * Create or strengthen a synapse between two neurons.
   */
  async connect(
    fromId: string,
    toId: string,
    type: SynapseType,
    context?: string,
    options?: {
      /** Strength when the synapse is created (default 0.5). Implicit links start weaker. */
      initialStrength?: number;
      /** On strengthen, keep whatever context is already there instead of replacing it. */
      keepExistingContext?: boolean;
    }
  ): Promise<{ synapse: Synapse; action: 'created' | 'strengthened' }> {
    const id = synapseId(fromId, toId);
    let synapse = await readJSON<Synapse>(this.brain.paths.synapse(id));
    let action: 'created' | 'strengthened';

    if (synapse) {
      // Strengthen existing synapse
      synapse.strength = Math.min(1.0, synapse.strength + 0.1);
      synapse.co_access_count += 1;
      synapse.last_co_access = now();
      if (context && !(options?.keepExistingContext && synapse.context)) {
        synapse.context = context;
      }
      action = 'strengthened';
    } else {
      // Create new synapse
      synapse = {
        id,
        nodes: [fromId, toId],
        strength: options?.initialStrength ?? 0.5,
        type,
        context: context || '',
        co_access_count: 1,
        last_co_access: now(),
      };
      action = 'created';

      // Update manifest
      const manifest = await this.brain.getManifest();
      await this.brain.updateManifest({ total_synapses: manifest.total_synapses + 1 });
    }

    await writeJSON(this.brain.paths.synapse(id), synapse);

    // Update neuron connection lists
    await this.addConnectionToNeuron(fromId, toId);
    await this.addConnectionToNeuron(toId, fromId);

    return { synapse, action };
  }

  /**
   * Get all connections for a neuron.
   */
  async getConnections(
    neuronId: string,
    minStrength?: number
  ): Promise<Array<{
    target_id: string;
    target_name: string;
    type: SynapseType;
    strength: number;
    context: string;
  }>> {
    const ids = await listJSONFiles(this.brain.paths.synapses);
    const connections: Array<{
      target_id: string;
      target_name: string;
      type: SynapseType;
      strength: number;
      context: string;
    }> = [];

    for (const id of ids) {
      const synapse = await readJSON<Synapse>(this.brain.paths.synapse(id));
      if (!synapse) continue;
      if (!synapse.nodes.includes(neuronId)) continue;
      if (minStrength && synapse.strength < minStrength) continue;

      const targetId = synapse.nodes[0] === neuronId ? synapse.nodes[1] : synapse.nodes[0];

      // Get target neuron name
      const targetNeuron = await readJSON<Neuron>(this.brain.paths.neuron(targetId));
      const targetName = targetNeuron?.name || targetId;

      connections.push({
        target_id: targetId,
        target_name: targetName,
        type: synapse.type,
        strength: synapse.strength,
        context: synapse.context,
      });
    }

    // Sort by strength descending
    connections.sort((a, b) => b.strength - a.strength);
    return connections;
  }

  /**
   * Get a specific synapse.
   */
  async get(nodeA: string, nodeB: string): Promise<Synapse | null> {
    const id = synapseId(nodeA, nodeB);
    return readJSON<Synapse>(this.brain.paths.synapse(id));
  }

  /**
   * Decay all synapses based on time since last co-access.
   * Returns number of pruned synapses (strength fell below threshold).
   */
  async decay(pruneThreshold: number = 0.05): Promise<number> {
    const ids = await listJSONFiles(this.brain.paths.synapses);
    let pruned = 0;

    for (const id of ids) {
      const synapse = await readJSON<Synapse>(this.brain.paths.synapse(id));
      if (!synapse) continue;

      // Calculate decay
      const lastAccess = new Date(synapse.last_co_access).getTime();
      const diffDays = (Date.now() - lastAccess) / (1000 * 60 * 60 * 24);

      let decayFactor = 1.0;
      if (diffDays > 90) decayFactor = 0.8;
      else if (diffDays > 30) decayFactor = 0.9;
      else if (diffDays > 7) decayFactor = 0.95;

      synapse.strength = Math.round(synapse.strength * decayFactor * 1000) / 1000;

      if (synapse.strength < pruneThreshold) {
        // Prune weak synapse
        const { deleteJSON } = await import('../utils/fs.js');
        await deleteJSON(this.brain.paths.synapse(id));

        // Remove from neuron connection lists
        await this.removeConnectionFromNeuron(synapse.nodes[0], synapse.nodes[1]);
        await this.removeConnectionFromNeuron(synapse.nodes[1], synapse.nodes[0]);

        const manifest = await this.brain.getManifest();
        await this.brain.updateManifest({ total_synapses: Math.max(0, manifest.total_synapses - 1) });

        pruned++;
      } else {
        await writeJSON(this.brain.paths.synapse(id), synapse);
      }
    }

    return pruned;
  }

  /**
   * Count total synapses.
   */
  async count(): Promise<number> {
    const ids = await listJSONFiles(this.brain.paths.synapses);
    return ids.length;
  }

  // ─── Private helpers ────────────────────────────────────────────

  private async addConnectionToNeuron(neuronId: string, connectedId: string): Promise<void> {
    const neuron = await readJSON<Neuron>(this.brain.paths.neuron(neuronId));
    if (!neuron) return;

    if (!neuron.connections.includes(connectedId)) {
      neuron.connections.push(connectedId);
      await writeJSON(this.brain.paths.neuron(neuronId), neuron);
    }
  }

  private async removeConnectionFromNeuron(neuronId: string, connectedId: string): Promise<void> {
    const neuron = await readJSON<Neuron>(this.brain.paths.neuron(neuronId));
    if (!neuron) return;

    neuron.connections = neuron.connections.filter(c => c !== connectedId);
    await writeJSON(this.brain.paths.neuron(neuronId), neuron);
  }
}
