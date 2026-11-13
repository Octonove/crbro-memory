// ─── CRBRO Synapses Engine ───────────────────────────────────────
// Connection management between neurons with strength decay

import { readJSON, updateJSON, listJSONFiles, deleteJSON, now, CorruptJSONError } from '../utils/fs.js';
import { withLock } from '../utils/lock.js';
import { synapseId } from '../utils/ids.js';
import { writeQuarantine } from './quarantine.js';
import type { Brain } from './brain.js';
import type { Synapse, SynapseType, Neuron } from '../types/index.js';

/** Strength is stored in [0, 1] with three decimals, like decay writes it. */
function clampStrength(value: number): number {
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return Math.round(v * 1000) / 1000;
}

const DAY_MS = 86_400_000;

/**
 * Weekly decay factor by how long the link has been idle. Applied for the
 * time actually elapsed since the last decay (2.11): until then the same
 * factor hit on EVERY maintenance run, so a brain maintained daily pruned an
 * idle link in a week and one maintained monthly in eight months.
 */
export function weeklyDecayFactor(idleDays: number): number {
  if (idleDays > 90) return 0.8;
  if (idleDays > 30) return 0.9;
  if (idleDays > 7) return 0.95;
  return 1;
}

/** Strength after `elapsedDays` of decay at the rate an `idleDays` idle link gets. */
export function decayedStrength(strength: number, idleDays: number, elapsedDays: number): number {
  const f = weeklyDecayFactor(idleDays);
  if (f === 1 || elapsedDays <= 0) return strength;
  return Math.round(strength * Math.pow(f, elapsedDays / 7) * 1000) / 1000;
}

export class Synapses {
  constructor(private brain: Brain) {}

  /**
   * Create or strengthen a synapse between two neurons.
   *
   * Every write goes through the same locked read-modify-write as the rest of
   * the brain (2.11). Before, the synapse file and BOTH neurons were read and
   * rewritten without a lock: a learn landing on a 1 MB neuron while
   * consolidate linked it lost its fact, silently.
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
    let action = 'strengthened' as 'created' | 'strengthened';
    const absoluta = typeof options?.strength === 'number' ? clampStrength(options.strength) : undefined;

    const synapse = await updateJSON<Synapse>(this.brain.paths.synapse(id), existing => {
      const cuando = now();
      if (existing) {
        // Strengthen existing synapse
        existing.strength = absoluta !== undefined ? absoluta : Math.min(1.0, existing.strength + 0.1);
        existing.co_access_count += 1;
        existing.last_co_access = cuando;
        // A fresh co-access restarts the decay clock.
        existing.decayed_at = cuando;
        if (context && !(options?.keepExistingContext && existing.context)) {
          existing.context = context;
        }
        action = 'strengthened';
        return existing;
      }
      action = 'created';
      return {
        id,
        nodes: [fromId, toId],
        strength: absoluta !== undefined ? absoluta : (options?.initialStrength ?? 0.5),
        type,
        context: context || '',
        co_access_count: 1,
        last_co_access: cuando,
        decayed_at: cuando,
      };
    });

    if (action === 'created') {
      const manifest = await this.brain.getManifest();
      await this.brain.updateManifest({ total_synapses: manifest.total_synapses + 1 });
    }

    // Update neuron connection lists
    await this.addConnectionToNeuron(fromId, toId);
    await this.addConnectionToNeuron(toId, fromId);

    return { synapse: synapse as Synapse, action };
  }

  /**
   * Remove one synapse and unlink both neurons. Absent → removed:false, no
   * error: "disconnect what is not connected" is a no-op, not a failure.
   */
  async disconnect(fromId: string, toId: string): Promise<{ synapse_id: string; removed: boolean }> {
    const id = synapseId(fromId, toId);
    const file = this.brain.paths.synapse(id);
    const synapse = await withLock(file, async () => {
      const s = await readJSON<Synapse>(file).catch(() => null);
      if (!s) return null;
      await deleteJSON(file);
      return s;
    });
    if (!synapse) return { synapse_id: id, removed: false };

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
    let found = false;
    const s = await updateJSON<Synapse>(this.brain.paths.synapse(id), current => {
      if (!current) return null;
      found = true;
      current.strength = clampStrength(strength);
      return current;
    });
    return found ? s : null;
  }

  /**
   * Remove every synapse touching a neuron. Returns how many went. Used when
   * a whole neuron is forgotten, after the Cortex has deleted its file.
   */
  async removeAllFor(neuronId: string): Promise<number> {
    let removed = 0;
    for (const id of await listJSONFiles(this.brain.paths.synapses)) {
      const synapse = await this.readSynapse(id);
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
      const synapse = await this.readSynapse(id);
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
      let fusion = false;
      await updateJSON<Synapse>(this.brain.paths.synapse(nuevoId), existente => {
        if (existente && nuevoId !== id) {
          fusion = true;
          existente.strength = clampStrength(Math.max(existente.strength, synapse.strength));
          existente.co_access_count = (existente.co_access_count || 0) + (synapse.co_access_count || 0);
          if ((synapse.last_co_access || '') > (existente.last_co_access || '')) {
            existente.last_co_access = synapse.last_co_access;
          }
          return existente;
        }
        return { ...synapse, id: nuevoId, nodes: [intoId, other] };
      });
      if (nuevoId !== id) await deleteJSON(this.brain.paths.synapse(id));
      if (fusion) out.merged++; else out.moved++;

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
      const synapse = await this.readSynapse(id);
      if (!synapse) continue;
      if (!synapse.nodes.includes(neuronId)) continue;
      if (minStrength && synapse.strength < minStrength) continue;

      const targetId = synapse.nodes[0] === neuronId ? synapse.nodes[1] : synapse.nodes[0];

      // Get target neuron name. An unreadable neighbour shows by its id.
      let targetNeuron: Neuron | null = null;
      try { targetNeuron = await readJSON<Neuron>(this.brain.paths.neuron(targetId)); } catch { /* corrupt */ }
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
   * Decay all synapses by the time elapsed since each was last decayed, and
   * prune the ones that fall below the threshold (a quarantine copy first).
   * Returns how many were pruned — or, with dryRun, how many would be, with
   * nothing written.
   *
   * A synapse written before 2.11 has no decayed_at: the first pass only
   * stamps it, so upgrading never applies a backlog of decay at once.
   */
  async decay(pruneThreshold: number = 0.05, options?: { dryRun?: boolean; now?: Date; skipNodes?: ReadonlySet<string> }): Promise<number> {
    const ids = await listJSONFiles(this.brain.paths.synapses);
    const ahora = options?.now ?? new Date();
    const ahoraIso = ahora.toISOString();
    let pruned = 0;

    for (const id of ids) {
      const file = this.brain.paths.synapse(id);
      const leida = await this.readSynapse(id);
      if (!leida) continue;
      // An archived neuron's links wait for it, untouched (2.11).
      if (options?.skipNodes && leida.nodes.some(n => options.skipNodes!.has(n))) continue;
      const idle = (ahora.getTime() - new Date(leida.last_co_access).getTime()) / DAY_MS;
      const desde = leida.decayed_at ? Date.parse(leida.decayed_at) : NaN;
      const elapsed = Number.isFinite(desde) ? (ahora.getTime() - desde) / DAY_MS : 0;
      const nueva = decayedStrength(leida.strength, idle, elapsed);

      if (nueva < pruneThreshold) {
        if (options?.dryRun) { pruned++; continue; }
        // Prune weak synapse: same path as an explicit disconnect, after a
        // copy — a link that took months to build is not deleted outright.
        await writeQuarantine(this.brain.paths.quarantine, leida.id || id, { ...leida, strength: nueva, pruned_at: ahoraIso }, 'whole');
        const r = await this.disconnect(leida.nodes[0], leida.nodes[1]);
        if (r.removed) pruned++;
        continue;
      }
      if (options?.dryRun) continue;
      // Write only when something changes: the strength, or the first stamp.
      // Unchanged, decayed_at stays where it was and the elapsed time keeps
      // accumulating, so slow decay is not rounded away run after run.
      if (nueva === leida.strength && leida.decayed_at) continue;
      await updateJSON<Synapse>(file, current => {
        if (!current) return null;
        // Re-derived from the fresh read under the lock: a strengthen that
        // landed meanwhile restarted the clock and is not undone.
        const idleNow = (ahora.getTime() - new Date(current.last_co_access).getTime()) / DAY_MS;
        const d = current.decayed_at ? Date.parse(current.decayed_at) : NaN;
        const el = Number.isFinite(d) ? (ahora.getTime() - d) / DAY_MS : 0;
        current.strength = Math.max(pruneThreshold, decayedStrength(current.strength, idleNow, el));
        current.decayed_at = ahoraIso;
        return current;
      });
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

  /** A synapse file, or null when absent or unreadable (the integrity check names those). */
  private async readSynapse(id: string): Promise<Synapse | null> {
    try {
      const s = await readJSON<Synapse>(this.brain.paths.synapse(id));
      return s && Array.isArray(s.nodes) && s.nodes.length === 2 ? s : null;
    } catch {
      return null;
    }
  }

  /**
   * Locked, and never creating: a neuron deleted meanwhile is not brought
   * back by a connection list. A corrupt neuron file throws — linking to it
   * would mean rewriting a file nobody can read.
   */
  private async addConnectionToNeuron(neuronId: string, connectedId: string): Promise<void> {
    await updateJSON<Neuron>(this.brain.paths.neuron(neuronId), current => {
      if (!current) return null;
      if (!Array.isArray(current.connections)) current.connections = [];
      if (current.connections.includes(connectedId)) return null;
      current.connections.push(connectedId);
      return current;
    });
  }

  /** Locked; a missing or unreadable neuron is left alone, never a reason to stop a disconnect. */
  private async removeConnectionFromNeuron(neuronId: string, connectedId: string): Promise<void> {
    try {
      await updateJSON<Neuron>(this.brain.paths.neuron(neuronId), current => {
        if (!current) return null;
        const antes = (current.connections || []).length;
        current.connections = (current.connections || []).filter(c => c !== connectedId);
        return current.connections.length === antes ? null : current;
      });
    } catch (err) {
      if (!(err instanceof CorruptJSONError)) throw err;
    }
  }
}
