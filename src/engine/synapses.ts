// ─── CRBRO Synapses Engine ───────────────────────────────────────
// Connection management between neurons with strength decay

import { readJSON, writeJSON, listJSONFiles, deleteJSON, now } from '../utils/fs.js';
import { synapseId } from '../utils/ids.js';
import type { Brain } from './brain.js';
import type { Synapse, SynapseType, Neuron } from '../types/index.js';

/** Strength is stored in [0, 1] with three decimals, like decay writes it. */
function clampStrength(value: number): number {
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return Math.round(v * 1000) / 1000;
}

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
      /**
       * Absolute strength 0..1, applied on create AND on strengthen instead
       * of the +0.1 rule. The caller says how strong the link is; the engine
       * stops guessing.
       */
      strength?: number;
    }
  ): Promise<{ synapse: Synapse; action: 'created' | 'strengthened' }> {
    const id = synapseId(fromId, toId);
    let synapse = await readJSON<Synapse>(this.brain.paths.synapse(id));
    let action: 'created' | 'strengthened';
    const absoluta = typeof options?.strength === 'number' ? clampStrength(options.strength) : undefined;

    if (synapse) {
      // Strengthen existing synapse
      synapse.strength = absoluta !== undefined ? absoluta : Math.min(1.0, synapse.strength + 0.1);
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
        strength: absoluta !== undefined ? absoluta : (options?.initialStrength ?? 0.5),
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
   * Remove one synapse and unlink both neurons. Absent → removed:false, no
   * error: "disconnect what is not connected" is a no-op, not a failure.
   */
  async disconnect(fromId: string, toId: string): Promise<{ synapse_id: string; removed: boolean }> {
    const id = synapseId(fromId, toId);
    const synapse = await readJSON<Synapse>(this.brain.paths.synapse(id));
    if (!synapse) return { synapse_id: id, removed: false };

    await deleteJSON(this.brain.paths.synapse(id));

    // Remove from neuron connection lists. Use the nodes the file recorded,
    // not the ids the caller passed: the id is order-free and prefix-free, so
    // the caller's spelling may differ from what the neurons hold.
    await this.removeConnectionFromNeuron(synapse.nodes[0], synapse.nodes[1]);
    await this.removeConnectionFromNeuron(synapse.nodes[1], synapse.nodes[0]);

    const manifest = await this.brain.getManifest();
    await this.brain.updateManifest({ total_synapses: Math.max(0, manifest.total_synapses - 1) });

    return { synapse_id: id, removed: true };
  }

  /**
   * Set the strength of an EXISTING synapse without touching anything else:
   * no co-access bump, no type or context change. Null when there is no such
   * synapse — this never creates one.
   */
  async setStrength(fromId: string, toId: string, strength: number): Promise<Synapse | null> {
    const id = synapseId(fromId, toId);
    const synapse = await readJSON<Synapse>(this.brain.paths.synapse(id));
    if (!synapse) return null;
    synapse.strength = clampStrength(strength);
    await writeJSON(this.brain.paths.synapse(id), synapse);
    return synapse;
  }

  /**
   * Remove every synapse touching a neuron. Returns how many went. Used when
   * a whole neuron is forgotten, after the Cortex has deleted its file.
   */
  async removeAllFor(neuronId: string): Promise<number> {
    let removed = 0;
    for (const id of await listJSONFiles(this.brain.paths.synapses)) {
      const synapse = await readJSON<Synapse>(this.brain.paths.synapse(id));
      if (!synapse || !synapse.nodes.includes(neuronId)) continue;
      const r = await this.disconnect(synapse.nodes[0], synapse.nodes[1]);
      if (r.removed) removed++;
    }
    return removed;
  }

  /**
   * Move every synapse of `fromId` onto `intoId`, for a neuron merge.
   *  - the other end is `intoId` itself → dropped (it would be a self loop);
   *  - `intoId` already links to the other end → merged: max strength, summed
   *    co-access, later last_co_access, the existing context kept;
   *  - otherwise the synapse is rewritten under its new id and nodes (moved).
   * Neuron connection lists follow. Manifest goes down by merged + dropped.
   */
  async rewire(fromId: string, intoId: string): Promise<{ moved: number; merged: number; dropped: number }> {
    const out = { moved: 0, merged: 0, dropped: 0 };
    if (fromId === intoId) return out;

    for (const id of await listJSONFiles(this.brain.paths.synapses)) {
      const synapse = await readJSON<Synapse>(this.brain.paths.synapse(id));
      if (!synapse || !synapse.nodes.includes(fromId)) continue;
      const other = synapse.nodes[0] === fromId ? synapse.nodes[1] : synapse.nodes[0];

      if (other === intoId) {
        await deleteJSON(this.brain.paths.synapse(id));
        await this.removeConnectionFromNeuron(intoId, fromId);
        out.dropped++;
        continue;
      }

      const nuevoId = synapseId(intoId, other);
      // Ids drop the type prefix, so two neurons differing only by prefix
      // yield the same synapse id: then the file stays, only the nodes move.
      const existente = nuevoId === id ? null : await readJSON<Synapse>(this.brain.paths.synapse(nuevoId));
      if (existente) {
        existente.strength = clampStrength(Math.max(existente.strength, synapse.strength));
        existente.co_access_count = (existente.co_access_count || 0) + (synapse.co_access_count || 0);
        if ((synapse.last_co_access || '') > (existente.last_co_access || '')) {
          existente.last_co_access = synapse.last_co_access;
        }
        await writeJSON(this.brain.paths.synapse(nuevoId), existente);
        await deleteJSON(this.brain.paths.synapse(id));
        out.merged++;
      } else {
        const movido: Synapse = { ...synapse, id: nuevoId, nodes: [intoId, other] };
        await writeJSON(this.brain.paths.synapse(nuevoId), movido);
        if (nuevoId !== id) await deleteJSON(this.brain.paths.synapse(id));
        out.moved++;
      }

      await this.removeConnectionFromNeuron(other, fromId);
      await this.addConnectionToNeuron(other, intoId);
      await this.addConnectionToNeuron(intoId, other);
    }

    const bajan = out.merged + out.dropped;
    if (bajan > 0) {
      const manifest = await this.brain.getManifest();
      await this.brain.updateManifest({ total_synapses: Math.max(0, manifest.total_synapses - bajan) });
    }
    return out;
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
        // Prune weak synapse: same path as an explicit disconnect.
        const r = await this.disconnect(synapse.nodes[0], synapse.nodes[1]);
        if (r.removed) pruned++;
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
