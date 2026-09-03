// ─── CRBRO Maintenance Engine ────────────────────────────────────
// Pruning, archiving, integrity checks, and consolidation

import { readJSON, writeJSON, updateJSON, listJSONFiles, moveFile, deleteJSON, now, today } from '../utils/fs.js';
import { sweepStaleLocks } from '../utils/lock.js';
import type { Brain } from './brain.js';
import type { Cortex } from './cortex.js';
import type { Synapses } from './synapses.js';
import type { HeatEngine } from './heat.js';
import type { Hippocampus } from './hippocampus.js';
import type { Prefrontal } from './prefrontal.js';
import type { SearchEngine } from '../search/index.js';
import type { Neuron } from '../types/index.js';

export interface MaintenanceReport {
  archived_neurons: number;
  /** Contentless miner leftovers found, and removed if asked. */
  boilerplate_facts: number;
  boilerplate_removed: number;
  /** Lock files left by a process that died mid-write. */
  stale_locks_swept: number;
  /** How many neurons WOULD be archived. Reported even when nothing is archived. */
  archivable_neurons: number;
  pruned_synapses: number;
  integrity_issues: string[];
  clusters_detected: number;
  index_rebuilt: boolean;
  heat_recalculated: boolean;
  /** Deliberate deferrals recorded with type:'debt', and how many never named a revisit condition. */
  debts_total: number;
  debts_without_trigger: number;
  notes: string[];
}

export class Maintenance {
  constructor(
    private brain: Brain,
    private cortex: Cortex,
    private synapses: Synapses,
    private heatEngine: HeatEngine,
    private hippocampus: Hippocampus,
    private prefrontal: Prefrontal,
    private searchEngine: SearchEngine,
  ) {}

  /**
   * Run full maintenance cycle.
   */
  async run(
    dryRun: boolean = false,
    options?: { archive?: boolean; purgeBoilerplate?: boolean }
  ): Promise<MaintenanceReport> {
    const report: MaintenanceReport = {
      archived_neurons: 0,
      boilerplate_facts: 0,
      boilerplate_removed: 0,
      stale_locks_swept: 0,
      archivable_neurons: 0,
      pruned_synapses: 0,
      integrity_issues: [],
      debts_total: 0,
      debts_without_trigger: 0,
      clusters_detected: 0,
      index_rebuilt: false,
      heat_recalculated: false,
      notes: [],
    };

    // 1. Recalculate heat scores.
    // Not in a dry run: recalculate() writes to disk, so running it here was
    // rewriting every neuron in what the caller was told was a simulation.
    if (!dryRun) {
      await this.heatEngine.recalculate();
      report.heat_recalculated = true;
    } else {
      report.notes.push('Dry run: heat was not recalculated and nothing was written.');
    }

    // 2. Cold neurons.
    //
    // Archiving is OPT-IN and off by default, and this is not caution for its
    // own sake: on the reference brain 1,028 of 1,183 neurons satisfy
    // "heat < 0.05 and untouched for 90 days" right now. The old code archived
    // them on any maintenance run, into a directory that is not indexed, not
    // searchable and has no restore path. One routine call would have swallowed
    // 87% of the memory. Heat decays with time, so a brain that is merely old
    // looks identical to a brain that is worthless.
    report.archivable_neurons = await this.countColdNeurons();
    if (options?.archive && !dryRun) {
      report.archived_neurons = await this.archiveColdNeurons();
      report.notes.push(
        `Archived ${report.archived_neurons} cold neurons to ${this.brain.paths.archives}. ` +
        'They are no longer searchable; move the files back into cortex/ to restore them.'
      );
    } else if (report.archivable_neurons > 0) {
      report.notes.push(
        `${report.archivable_neurons} neurons are cold enough to archive. Nothing was archived: ` +
        'pass archive:true if you have reviewed the list and really want them out of the way.'
      );
    }

    // 2b. Miner leftovers.
    //
    // Early versions of the miner recorded "Referenced in: <file>" for every
    // technology it spotted. That is not knowledge — it says a word appeared
    // in a file — and on the reference brain it was 708 of 4,273 facts, with
    // 48 neurons made of nothing else. Counting is free; removing is opt-in.
    report.boilerplate_facts = await this.countBoilerplate();
    if (options?.purgeBoilerplate && !dryRun) {
      report.boilerplate_removed = await this.purgeBoilerplate();
      report.notes.push(
        `Removed ${report.boilerplate_removed} contentless miner fact(s). ` +
        'Neurons left with nothing in them were not deleted; review them with crbro_neurons.'
      );
    } else if (report.boilerplate_facts > 0) {
      report.notes.push(
        `${report.boilerplate_facts} contentless miner fact(s) ("Referenced in: ...") are taking up ` +
        'space and index slots. Pass purge_boilerplate:true to remove them.'
      );
    }

    // 2c. Locks abandoned by a process that died mid-write.
    if (!dryRun) {
      report.stale_locks_swept = await sweepStaleLocks(this.brain.paths.cortex);
    }

    // 3. Decay and prune weak synapses
    if (!dryRun) {
      report.pruned_synapses = await this.synapses.decay(0.05);
    }

    // 4. Integrity check
    report.integrity_issues = await this.checkIntegrity();

    // The debt ledger: a deferral that never named its revisit condition is
    // on its way to becoming permanent by accident. Count them and say so —
    // "later" without a trigger means "never".
    const sinDisparador: string[] = [];
    for (const id of await listJSONFiles(this.brain.paths.cortex)) {
      const n = await readJSON<Neuron>(this.brain.paths.neuron(id));
      if (!n || !n.debts || n.debts.length === 0) continue;
      report.debts_total += n.debts.length;
      const sin = n.debts.filter(d => !/REVISAR CUANDO|REVISIT WHEN|TRIGGER:|DISPARADOR/i.test(d));
      if (sin.length > 0) sinDisparador.push(`${n.name || id} (${sin.length})`);
      report.debts_without_trigger += sin.length;
    }
    if (report.debts_without_trigger > 0) {
      report.notes.push(
        `${report.debts_without_trigger} debt(s) never named a revisit condition — a deferral ` +
        `without a trigger quietly becomes permanent. Neurons: ${sinDisparador.join(', ')}. ` +
        `Rewrite them with a "REVISAR CUANDO:" clause.`);
    }

    // 5. Rebuild global map
    const globalMap = await this.prefrontal.buildGlobalMap();
    report.clusters_detected = globalMap.clusters.length;

    // 6. Rebuild search index
    if (!dryRun) {
      await this.searchEngine.rebuild();
      report.index_rebuilt = true;
    }

    // 7. Update manifest
    if (!dryRun) {
      const neuronCount = await this.cortex.count();
      const synapseCount = await this.synapses.count();
      await this.brain.updateManifest({
        total_neurons: neuronCount,
        total_synapses: synapseCount,
        last_consolidation: now(),
      });
    }

    return report;
  }

  /**
   * Consolidate session — called at end of session.
   */
  async consolidate(summary: string): Promise<{
    facts_saved: number;
    decisions_saved: number;
    topics_touched: number;
    total_neurons: number;
    /** Synapses created or strengthened by THIS consolidation (implicit links). */
    synapses_updated: number;
    total_synapses: number;
    session_logged: boolean;
  }> {
    // Persist search index
    await this.searchEngine.persist();

    // Log session
    const neuronCount = await this.cortex.count();

    // Real numbers, not the neuron count. `facts_saved` used to return the
    // total number of neurons, so it answered the same figure whether the
    // session had stored one fact or thirty — and it is the only number the
    // assistant sees when closing a session.
    const escrito = this.cortex.sessionTally();

    // Implicit synapses: neurons written in the same session are related by
    // that alone. Until 1.13 only crbro_connect created synapses, and nobody
    // calls it — the reference brain had 14 synapses for 1,145 neurons, so
    // the connectivity share of heat (25%) weighed nothing and the global map
    // had no bridges. Links start weak (0.3), typed temporal, and never
    // overwrite a context somebody wrote by hand; decay and pruning apply.
    // Capped at six topics (15 pairs) so a sprawling session cannot wire
    // everything to everything.
    let synapsesTouched = 0;
    const topicos = escrito.topics.slice(0, 6);
    for (let i = 0; i < topicos.length; i++) {
      for (let j = i + 1; j < topicos.length; j++) {
        try {
          await this.synapses.connect(
            topicos[i], topicos[j], 'temporal',
            `written in the same session (${today()})`,
            { initialStrength: 0.3, keepExistingContext: true },
          );
          synapsesTouched++;
        } catch {
          // A missing neuron must not break the consolidation.
        }
      }
    }
    const synapseCount = await this.synapses.count();

    await this.hippocampus.logSession({
      summary,
      topics_touched: escrito.topics,
      key_facts_added: escrito.facts,
      decisions_made: escrito.decisions,
    });

    // Update active context
    await this.prefrontal.updateContext({});

    // Recalculate heat
    await this.heatEngine.recalculate();

    // Update manifest
    await this.brain.updateManifest({
      total_neurons: neuronCount,
      total_synapses: synapseCount,
      last_consolidation: now(),
    });

    this.cortex.resetSessionTally();

    return {
      facts_saved: escrito.facts,
      decisions_saved: escrito.decisions,
      topics_touched: escrito.topics.length,
      total_neurons: neuronCount,
      synapses_updated: synapsesTouched,
      total_synapses: synapseCount,
      session_logged: true,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /** "Referenced in: x.md" and "Mined from x.md" carry no information. */
  private isBoilerplate(text: string): boolean {
    return /^(Referenced in|Mined from):?\s/i.test((text || '').trim());
  }

  private async countBoilerplate(): Promise<number> {
    let n = 0;
    for (const id of await this.cortex.allIds()) {
      const neuron = await readJSON<Neuron>(this.brain.paths.neuron(id));
      if (!neuron) continue;
      n += (neuron.facts || []).filter(f => this.isBoilerplate(f.text)).length;
    }
    return n;
  }

  private async purgeBoilerplate(): Promise<number> {
    let removed = 0;
    for (const id of await this.cortex.allIds()) {
      await updateJSON<Neuron>(this.brain.paths.neuron(id), current => {
        if (!current) return null;
        const antes = (current.facts || []).length;
        current.facts = (current.facts || []).filter(f => !this.isBoilerplate(f.text));
        const quitados = antes - current.facts.length;
        if (quitados === 0) return null;
        removed += quitados;
        return current;
      });
    }
    if (removed > 0) await this.searchEngine.rebuild();
    return removed;
  }

  private async archiveColdNeurons(): Promise<number> {
    const ids = await this.cortex.allIds();
    let archived = 0;

    for (const id of ids) {
      const neuron = await readJSON<Neuron>(this.brain.paths.neuron(id));
      if (!neuron) continue;

      // Archive if heat < 0.05 and not accessed in 90+ days
      const lastAccess = new Date(neuron.last_accessed).getTime();
      const diffDays = (Date.now() - lastAccess) / (1000 * 60 * 60 * 24);

      if (neuron.heat < 0.05 && diffDays > 90) {
        await moveFile(
          this.brain.paths.neuron(id),
          `${this.brain.paths.archives}/${id}.json`
        );
        archived++;
      }
    }

    return archived;
  }

  private async countColdNeurons(): Promise<number> {
    const ids = await this.cortex.allIds();
    let count = 0;

    for (const id of ids) {
      const neuron = await readJSON<Neuron>(this.brain.paths.neuron(id));
      if (!neuron) continue;

      const lastAccess = new Date(neuron.last_accessed).getTime();
      const diffDays = (Date.now() - lastAccess) / (1000 * 60 * 60 * 24);

      if (neuron.heat < 0.05 && diffDays > 90) count++;
    }

    return count;
  }

  private async checkIntegrity(): Promise<string[]> {
    const issues: string[] = [];
    const ids = await this.cortex.allIds();

    for (const id of ids) {
      const neuron = await readJSON<Neuron>(this.brain.paths.neuron(id));
      if (!neuron) {
        issues.push(`Corrupted neuron file: ${id}`);
        continue;
      }

      // Check for broken connections
      for (const connId of neuron.connections) {
        const connected = await readJSON<Neuron>(this.brain.paths.neuron(connId));
        if (!connected) {
          issues.push(`Broken connection: ${id} → ${connId} (target missing)`);
        }
      }
    }

    return issues;
  }
}
