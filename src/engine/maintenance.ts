// ─── CRBRO Maintenance Engine ────────────────────────────────────
// Pruning, archiving, integrity checks, and consolidation

import { readJSON, writeJSON, listJSONFiles, moveFile, now, today } from '../utils/fs.js';
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
  /** How many neurons WOULD be archived. Reported even when nothing is archived. */
  archivable_neurons: number;
  pruned_synapses: number;
  integrity_issues: string[];
  clusters_detected: number;
  index_rebuilt: boolean;
  heat_recalculated: boolean;
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
  async run(dryRun: boolean = false, options?: { archive?: boolean }): Promise<MaintenanceReport> {
    const report: MaintenanceReport = {
      archived_neurons: 0,
      archivable_neurons: 0,
      pruned_synapses: 0,
      integrity_issues: [],
      clusters_detected: 0,
      index_rebuilt: false,
      heat_recalculated: false,
      notes: [],
    };

    // 1. Recalculate heat scores
    await this.heatEngine.recalculate();
    report.heat_recalculated = true;

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

    // 3. Decay and prune weak synapses
    if (!dryRun) {
      report.pruned_synapses = await this.synapses.decay(0.05);
    }

    // 4. Integrity check
    report.integrity_issues = await this.checkIntegrity();

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
    synapses_updated: number;
    session_logged: boolean;
  }> {
    // Persist search index
    await this.searchEngine.persist();

    // Log session
    const neuronCount = await this.cortex.count();
    const synapseCount = await this.synapses.count();

    await this.hippocampus.logSession({
      summary,
      topics_touched: [],
      key_facts_added: 0,
      decisions_made: 0,
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

    return {
      facts_saved: neuronCount,
      synapses_updated: synapseCount,
      session_logged: true,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────

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
