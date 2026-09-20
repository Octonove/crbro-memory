// ─── CRBRO Maintenance Engine ────────────────────────────────────
// Pruning, archiving, integrity checks, repair, and consolidation

import { readJSON, updateJSON, listJSONFiles, moveFile, deleteJSON, fileExists, now, today } from '../utils/fs.js';
import { sweepStaleLocks } from '../utils/lock.js';
import { entryId } from '../sync/ops.js';
import { inferEntryDay, isDayPrecision, datesInText } from './dates.js';
import { fold } from '../search/tokenize.js';
import { factId } from '../utils/hash.js';
import type { Brain } from './brain.js';
import type { Cortex } from './cortex.js';
import type { Synapses } from './synapses.js';
import type { HeatEngine } from './heat.js';
import type { Hippocampus } from './hippocampus.js';
import type { Prefrontal } from './prefrontal.js';
import type { SearchEngine } from '../search/index.js';
import type { Neuron, Synapse } from '../types/index.js';

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
  /** Deliberate deferrals recorded with type:'debt', and how many never named a revisit condition. Retired debts are not counted. */
  debts_total: number;
  debts_without_trigger: number;
  /** Files sitting in archives/ after this run. */
  archives_count: number;
  /** Neurons moved back from archives/ into cortex/ by this run. */
  unarchived_neurons: number;
  /** Integrity issues a repair would fix (= integrity_issues.length, in every mode). */
  repairable: number;
  /** Fixes applied by this run (0 unless repair:true and not a dry run). */
  repaired: number;
  /** One line per fix applied. */
  repairs: string[];
  /** Patterns, preferences, errors and debts with no date: written before 1.13 stamped them. */
  undated_entries: number;
  /** How many of those state a date in their own text — what backfill_dates recovers. */
  datable_entries: number;
  /** Dates written by this run (0 unless backfill_dates:true and not a dry run). */
  dates_backfilled: number;
  /** Live entries that named a day still ahead of them when written, and that day has passed. */
  expired_entries: number;
  /** The longest-expired of them, to review: keep, crbro_revise, or crbro_learn supersedes. Never touched by maintenance. */
  expired_sample: ExpiredEntry[];
  /** Neurons past SPLIT_MIN_ENTRIES live entries, each with the groups its own words suggest. */
  split_candidates: SplitCandidate[];
  notes: string[];
}

export interface ExpiredEntry {
  neuron_id: string;
  entry_id: string;
  kind: string;
  /** When the entry was written. */
  added: string;
  /** The day it looked forward to, now behind us. */
  due: string;
  preview: string;
}

export interface SplitCandidate {
  neuron_id: string;
  name: string;
  entries: number;
  /** Words that gather a sizeable share of the entries without gathering all of them. */
  groups: Array<{ term: string; entries: number }>;
}

/** A neuron this big no longer fits one read: crbro_inspect pages it, and every recall hit from it competes with 80 siblings. */
const SPLIT_MIN_ENTRIES = 80;
const SPLIT_MAX_CANDIDATES = 8;
const SPLIT_GROUPS = 5;
const EXPIRED_SAMPLE = 10;
/** Too common to name a subtopic. Short on purpose: the share bounds below do most of the work. */
const SPLIT_STOP = new Set(('para como pero este esta estos estas desde hasta entre sobre cuando donde porque tambien todos todas cada '
  + 'tiene tienen hace hacer puede pueden debe deben usar solo antes despues ahora siempre nunca mismo misma nueva nuevo '
  + 'with from that this those these when where which while into over under after before there their have does must should '
  + 'only always never using used more than then also each both were been being').split(' '));

/** Every text an entry_dates / entry_status key may legitimately point at. */
function liveEntryKeys(n: Neuron): Set<string> {
  return new Set([
    ...(n.decisions || []).map(d => d.text),
    ...(n.patterns || []), ...(n.preferences || []),
    ...(n.errors || []), ...(n.debts || []),
  ].map(entryId));
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
    options?: { archive?: boolean; purgeBoilerplate?: boolean; repair?: boolean; unarchive?: string[] | 'all'; backfillDates?: boolean }
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
      archives_count: 0,
      unarchived_neurons: 0,
      repairable: 0,
      repaired: 0,
      repairs: [],
      undated_entries: 0,
      datable_entries: 0,
      dates_backfilled: 0,
      expired_entries: 0,
      expired_sample: [],
      split_candidates: [],
      notes: [],
    };

    // 0. Bring neurons back from the archive, before anything else could
    // archive them again in the same pass.
    const recuperados = new Set<string>();
    if (options?.unarchive && !dryRun) {
      const r = await this.unarchive(options.unarchive);
      report.unarchived_neurons = r.restored.length;
      for (const id of r.restored) recuperados.add(id);
      if (r.restored.length > 0) {
        report.notes.push(`Unarchived ${r.restored.length} neuron(s) back into cortex/ and reindexed them: ${r.restored.join(', ')}.`);
      }
      if (r.unknown.length > 0) {
        report.notes.push(`Not in archives/, nothing to unarchive: ${r.unknown.join(', ')}.`);
      }
      if (r.already.length > 0) {
        report.notes.push(`Already present in cortex/, archive copy left in place: ${r.already.join(', ')}.`);
      }
    } else if (options?.unarchive && dryRun) {
      report.notes.push('Dry run: nothing was unarchived.');
    }

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
    report.archivable_neurons = await this.countColdNeurons(recuperados);
    if (options?.archive && !dryRun) {
      report.archived_neurons = await this.archiveColdNeurons(recuperados);
      report.notes.push(
        `Archived ${report.archived_neurons} cold neurons to ${this.brain.paths.archives}. ` +
        'They are no longer searchable; pass unarchive:[ids] (or "all") to bring them back.'
      );
    } else if (report.archivable_neurons > 0) {
      report.notes.push(
        `${report.archivable_neurons} neurons are cold enough to archive. Nothing was archived: ` +
        'pass archive:true if you have reviewed the list and really want them out of the way.'
      );
    }
    report.archives_count = (await listJSONFiles(this.brain.paths.archives)).length;

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
        'Neurons left with nothing in them were not deleted; review them with crbro_inspect view=neurons.'
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
    report.repairable = report.integrity_issues.length;

    // 4b. Repair what the check found. Opt-in and never in a dry run.
    if (options?.repair && !dryRun) {
      report.repairs = await this.repair();
      report.repaired = report.repairs.length;
      if (report.repaired > 0) {
        report.notes.push(`Repaired ${report.repaired} integrity issue(s); see repairs[].`);
        // What is left after the fixes, so the report does not list issues that are gone.
        report.integrity_issues = await this.checkIntegrity();
      }
    } else if (report.repairable > 0) {
      report.notes.push(
        `${report.repairable} integrity issue(s) found. Pass repair:true to fix dangling connections, ` +
        'orphan synapses, stale sidecar keys and manifest counters.'
      );
    }

    // 4c. Entries from before 1.13 have no date, so recall cannot say which of
    // two tellings is the recent one. Counting is free; writing is opt-in, and
    // only what the entry's own text proves is ever written (see dates.ts).
    const fechas = await this.backfillDates(!!options?.backfillDates && !dryRun);
    report.undated_entries = fechas.undated;
    report.datable_entries = fechas.datable;
    report.dates_backfilled = fechas.written;
    if (fechas.written > 0) {
      report.notes.push(
        `Dated ${fechas.written} entr${fechas.written === 1 ? 'y' : 'ies'} from the date stated in their own text, ` +
        `to the day. ${fechas.undated - fechas.written} state none and stay undated: nothing was guessed.`);
    } else if (fechas.datable > 0) {
      report.notes.push(
        `${fechas.undated} pattern/preference/error/debt entr${fechas.undated === 1 ? 'y has' : 'ies have'} no date ` +
        `(written before 1.13); ${fechas.datable} state one in their own text. Pass backfill_dates:true to record it.`);
    }

    // 4d. What the brain still says as current although its own words put a
    // date on it, and what has outgrown a single read. Read-only, both: what
    // to do with a line is a judgement, and maintenance does not make it.
    const revision = await this.reviewEntries();
    report.expired_entries = revision.expired;
    report.expired_sample = revision.sample;
    report.split_candidates = revision.splits;
    if (revision.expired > 0) {
      report.notes.push(
        `${revision.expired} live entr${revision.expired === 1 ? 'y names' : 'ies name'} a day that was still ahead when written and has ` +
        'since passed — a deadline, a "until", a planned step. expired_sample lists the oldest: confirm each is still true, ' +
        'or retire it with crbro_revise / replace it with crbro_learn supersedes.');
    }
    if (revision.splits.length > 0) {
      report.notes.push(
        `${revision.splits.length} neuron(s) hold ${SPLIT_MIN_ENTRIES}+ live entries (split_candidates, with the groups their own words suggest). ` +
        'To split one: crbro_inspect view=neuron for the entry ids, then crbro_revise move_to — the entries keep their dates.');
    }

    // The debt ledger: a deferral that never named its revisit condition is
    // on its way to becoming permanent by accident. Count them and say so —
    // "later" without a trigger means "never". Retired debts (entry_status)
    // are settled and do not count.
    const sinDisparador: string[] = [];
    for (const id of await listJSONFiles(this.brain.paths.cortex)) {
      const n = await readJSON<Neuron>(this.brain.paths.neuron(id));
      if (!n || !n.debts || n.debts.length === 0) continue;
      const vivas = n.debts.filter(d => !n.entry_status?.[entryId(d)]);
      if (vivas.length === 0) continue;
      report.debts_total += vivas.length;
      const sin = vivas.filter(d => !/REVISAR CUANDO|REVISIT WHEN|TRIGGER:|DISPARADOR/i.test(d));
      if (sin.length > 0) sinDisparador.push(`${n.name || id} (${sin.length})`);
      report.debts_without_trigger += sin.length;
    }
    if (report.debts_without_trigger > 0) {
      report.notes.push(
        `${report.debts_without_trigger} debt(s) never named a revisit condition — a deferral ` +
        `without a trigger quietly becomes permanent. Neurons: ${sinDisparador.join(', ')}. ` +
        `Rewrite them with a "REVISAR CUANDO:" clause.`);
    }

    // 5. Global map — computed live, never written. In both modes: this is
    // what lets a dry run promise that it touches nothing on disk.
    const globalMap = await this.prefrontal.getGlobalMap();
    report.clusters_detected = globalMap.clusters.length;
    if (!dryRun && await fileExists(this.brain.paths.globalMap())) {
      await deleteJSON(this.brain.paths.globalMap());
      report.notes.push('Removed the obsolete global_map.json cache; the map is computed live.');
    }

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
  async consolidate(summary: string, options?: {
    /**
     * Neuron ids the session touched WITHOUT writing (recalled, inspected,
     * discussed). Unioned into the log's topics_touched next to the ids the
     * tally saw written; the write counters stay real. Unknown ids are
     * dropped and reported, never logged. This is what crbro_session_log's
     * topics_touched did in 1.x.
     */
    topicsTouched?: string[];
  }): Promise<{
    facts_saved: number;
    decisions_saved: number;
    topics_touched: number;
    total_neurons: number;
    /** Synapses created or strengthened by THIS consolidation (implicit links). */
    synapses_updated: number;
    total_synapses: number;
    session_logged: boolean;
    session_id: string;
    /** Credential kinds stripped from the summary before it was stored. Never the values. */
    redacted: string[];
    /** Every neuron id written into the log's topics_touched by this call: the tally's plus options.topicsTouched. */
    topics_logged: string[];
    /** Ids in options.topicsTouched that name no neuron — dropped, not logged. */
    topics_unknown: string[];
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

    // Topics the session touched without writing: only ids that exist, each
    // once, and not already counted by the tally. They join the log, not the
    // implicit-synapse pass above (reading two neurons is no evidence they
    // are related) and not the write counters.
    const leidos: string[] = [];
    const desconocidos: string[] = [];
    const yaVistos = new Set(escrito.topics);
    for (const raw of options?.topicsTouched ?? []) {
      const id = String(raw ?? '').trim();
      if (!id || yaVistos.has(id)) continue;
      yaVistos.add(id);
      if (await this.cortex.peek(id)) leidos.push(id);
      else desconocidos.push(id);
    }
    const topicosLog = [...escrito.topics, ...leidos];

    const log = await this.hippocampus.logSession({
      summary,
      topics_touched: topicosLog,
      key_facts_added: escrito.facts,
      decisions_made: escrito.decisions,
    });

    // Point the active context at the session just logged. This used to be
    // updateContext({}), which rewrote the file and set nothing, so boot
    // reported last_session: null forever.
    await this.prefrontal.setLastSession(log.session_id);

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
      session_id: log.session_id,
      redacted: log.redacted,
      topics_logged: topicosLog,
      topics_unknown: desconocidos,
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

  /** Cold: heat below 0.05 and untouched for more than 90 days. */
  private isCold(neuron: Neuron): boolean {
    const lastAccess = new Date(neuron.last_accessed).getTime();
    const diffDays = (Date.now() - lastAccess) / (1000 * 60 * 60 * 24);
    return neuron.heat < 0.05 && diffDays > 90;
  }

  private async archiveColdNeurons(skip: Set<string> = new Set()): Promise<number> {
    const ids = await this.cortex.allIds();
    let archived = 0;

    for (const id of ids) {
      if (skip.has(id)) continue;
      const neuron = await readJSON<Neuron>(this.brain.paths.neuron(id));
      if (!neuron) continue;

      if (this.isCold(neuron)) {
        await moveFile(
          this.brain.paths.neuron(id),
          `${this.brain.paths.archives}/${id}.json`
        );
        archived++;
      }
    }

    return archived;
  }

  private async countColdNeurons(skip: Set<string> = new Set()): Promise<number> {
    const ids = await this.cortex.allIds();
    let count = 0;

    for (const id of ids) {
      if (skip.has(id)) continue;
      const neuron = await readJSON<Neuron>(this.brain.paths.neuron(id));
      if (!neuron) continue;
      if (this.isCold(neuron)) count++;
    }

    return count;
  }

  /**
   * Move neurons from archives/ back into cortex/ and index them. A neuron
   * that exists in cortex/ again is not overwritten: the archive copy stays
   * and the id is reported in `already`.
   */
  private async unarchive(which: string[] | 'all'): Promise<{ restored: string[]; unknown: string[]; already: string[] }> {
    const out = { restored: [] as string[], unknown: [] as string[], already: [] as string[] };
    const enArchivo = await listJSONFiles(this.brain.paths.archives);
    const pedidos = which === 'all'
      ? enArchivo
      : [...new Set(which.map(s => String(s || '').trim()).filter(Boolean))];

    for (const id of pedidos) {
      const origen = `${this.brain.paths.archives}/${id}.json`;
      if (!enArchivo.includes(id) || !(await fileExists(origen))) {
        out.unknown.push(id);
        continue;
      }
      const destino = this.brain.paths.neuron(id);
      if (await fileExists(destino)) {
        out.already.push(id);
        continue;
      }
      await moveFile(origen, destino);
      out.restored.push(id);
      try {
        const neuron = await readJSON<Neuron>(destino);
        if (neuron) await this.searchEngine.indexNeuron(neuron);
      } catch {
        // The index is derived data; the file is back either way.
      }
    }
    return out;
  }

  /**
   * What is inconsistent on disk. Every line here names something repair()
   * knows how to fix, except a corrupted neuron file, which nobody should
   * fix blindly.
   */
  private async checkIntegrity(): Promise<string[]> {
    const issues: string[] = [];
    const ids = await this.cortex.allIds();
    const existe = new Set(ids);

    for (const id of ids) {
      let neuron: Neuron | null;
      try {
        neuron = await readJSON<Neuron>(this.brain.paths.neuron(id));
      } catch {
        neuron = null;
      }
      if (!neuron) {
        issues.push(`Corrupted neuron file: ${id}`);
        continue;
      }

      // Check for broken connections
      for (const connId of neuron.connections || []) {
        if (!existe.has(connId)) {
          issues.push(`Broken connection: ${id} → ${connId} (target missing)`);
        }
      }

      // Sidecar keys pointing at entries that no longer exist.
      const vivos = liveEntryKeys(neuron);
      for (const k of Object.keys(neuron.entry_dates || {})) {
        if (!vivos.has(k)) issues.push(`Stale entry_dates key in ${id}: ${k}`);
      }
      for (const k of Object.keys(neuron.entry_status || {})) {
        if (!vivos.has(k)) issues.push(`Stale entry_status key in ${id}: ${k}`);
      }
    }

    // Synapse files whose ends no longer both exist.
    const synIds = await listJSONFiles(this.brain.paths.synapses);
    for (const sid of synIds) {
      let synapse: Synapse | null;
      try {
        synapse = await readJSON<Synapse>(this.brain.paths.synapse(sid));
      } catch {
        synapse = null;
      }
      if (!synapse || !Array.isArray(synapse.nodes) || synapse.nodes.length !== 2) {
        issues.push(`Corrupted synapse file: ${sid}`);
        continue;
      }
      for (const node of synapse.nodes) {
        if (!existe.has(node)) issues.push(`Orphan synapse: ${sid} (neuron ${node} missing)`);
      }
    }

    // Manifest counters that disagree with the disk.
    const manifest = await this.brain.getManifest();
    const sesiones = (await listJSONFiles(this.brain.paths.hippocampus)).length;
    if (manifest.total_neurons !== ids.length) {
      issues.push(`Manifest says ${manifest.total_neurons} neurons, disk has ${ids.length}`);
    }
    if (manifest.total_synapses !== synIds.length) {
      issues.push(`Manifest says ${manifest.total_synapses} synapses, disk has ${synIds.length}`);
    }
    if (manifest.total_sessions !== sesiones) {
      issues.push(`Manifest says ${manifest.total_sessions} sessions, disk has ${sesiones}`);
    }

    return issues;
  }

  /**
   * Two read-only reviews in one pass over the cortex.
   *
   * Expired: a live, dated entry whose text states a day LATER than the day
   * it was written — so it was looking forward — and that day is now behind
   * us. Language-independent on purpose: no list of "hasta / until / vence"
   * to maintain, just two dates and today. An entry that only mentions past
   * days is history, not a promise, and is never flagged. Undated entries
   * cannot be judged and are skipped (backfill_dates first).
   *
   * Split: a neuron with SPLIT_MIN_ENTRIES+ live entries, with the words
   * that gather between 8% and 45% of them — frequent enough to be a
   * subtopic, not so frequent that they are just the neuron's own name.
   */
  private async reviewEntries(): Promise<{ expired: number; sample: ExpiredEntry[]; splits: SplitCandidate[] }> {
    const hoy = today();
    const vencidas: ExpiredEntry[] = [];
    const gordas: SplitCandidate[] = [];
    const enNeuronas = new Map<string, number>();
    const grandes: Array<{ n: Neuron; vivas: number; palabras: Array<Set<string>>; propias: Set<string> }> = [];
    let total = 0;

    for (const id of await this.cortex.allIds()) {
      let n: Neuron | null;
      try {
        n = await readJSON<Neuron>(this.brain.paths.neuron(id));
      } catch {
        continue;
      }
      if (!n || n.type === 'protocol') continue;

      const retirada = (t: string) => !!n!.entry_status?.[entryId(t)];
      const vivas: Array<{ eid: string; kind: string; text: string; added: string }> = [];
      for (const f of n.facts || []) {
        if (!f?.text || (f.status && f.status !== 'active')) continue;
        vivas.push({ eid: f.id || factId(f.text), kind: 'fact', text: f.text, added: f.added || '' });
      }
      for (const d of n.decisions || []) {
        if (!d?.text || retirada(d.text)) continue;
        vivas.push({ eid: d.id || entryId(d.text), kind: 'decision', text: d.text, added: d.date || '' });
      }
      const sueltas: Array<[string, string[] | undefined]> = [
        ['pattern', n.patterns], ['preference', n.preferences], ['error', n.errors], ['debt', n.debts],
      ];
      for (const [kind, lista] of sueltas) {
        for (const t of lista || []) {
          if (!t || retirada(t)) continue;
          vivas.push({ eid: entryId(t), kind, text: t, added: n.entry_dates?.[entryId(t)] || '' });
        }
      }

      for (const e of vivas) {
        const escrita = e.added.slice(0, 10);
        if (!escrita) continue;
        // Two days of margin, not one: stamps are UTC and people write local
        // dates, so an entry saved at 00:30 on the 13th in Madrid is stamped
        // the 12th and says "13/06". On the reference brain that alone was
        // 250 of 277 flags — every one of them a false alarm.
        const desde = new Date(Date.parse(escrita) + 2 * 86_400_000).toISOString().slice(0, 10);
        let due = '';
        for (const f of datesInText(e.text)) {
          if (f.alt) continue;   // reads two ways: not evidence of anything
          if (f.day >= desde && f.day < hoy && f.day > due) due = f.day;
        }
        if (!due) continue;
        vencidas.push({
          neuron_id: n.id, entry_id: e.eid, kind: e.kind, added: escrita, due,
          preview: e.text.length > 160 ? `${e.text.slice(0, 160).trimEnd()}…` : e.text,
        });
      }

      // Words per entry, once: they feed this neuron's groups and the
      // brain-wide count that tells a subtopic from a habit of speech.
      const propias = new Set(fold(n.name).split(/[^a-z0-9]+/).filter(Boolean));
      const palabras = vivas.map(e => new Set(
        fold(e.text).split(/[^a-z0-9]+/).filter(w => w.length >= 5 && !SPLIT_STOP.has(w) && !/^\d+$/.test(w))));
      total++;
      for (const w of new Set(palabras.flatMap(set => [...set]))) enNeuronas.set(w, (enNeuronas.get(w) || 0) + 1);

      if (vivas.length >= SPLIT_MIN_ENTRIES) {
        grandes.push({ n, vivas: vivas.length, palabras, propias });
      }
    }

    // A word found in many neurons is how this person writes ("verificado",
    // "usuario"), not what this neuron is about. Measured on the reference
    // brain, the top group of its largest neuron was "verificado (180)".
    const comun = Math.max(10, Math.ceil(total * 0.04));
    for (const { n, vivas, palabras, propias } of grandes) {
      {
        const donde = new Map<string, Set<number>>();
        palabras.forEach((set, i) => {
          for (const w of set) {
            if (propias.has(w) || (enNeuronas.get(w) || 0) > comun) continue;
            const d = donde.get(w);
            if (d) d.add(i); else donde.set(w, new Set([i]));
          }
        });
        const min = Math.ceil(vivas * 0.08), max = Math.floor(vivas * 0.45);
        // Greedy, by size: a word joins only if most of its entries are not
        // already gathered by a word chosen before it — otherwise the five
        // groups are five names for the same one ("newsletter", "envio", ...).
        const cubiertas = new Set<number>();
        const groups: Array<{ term: string; entries: number }> = [];
        const orden = [...donde.entries()]
          .filter(([, set]) => set.size >= min && set.size <= max)
          .sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1));
        for (const [term, set] of orden) {
          if (groups.length >= SPLIT_GROUPS) break;
          let repetidas = 0;
          for (const i of set) if (cubiertas.has(i)) repetidas++;
          if (repetidas > set.size / 2) continue;
          groups.push({ term, entries: set.size });
          for (const i of set) cubiertas.add(i);
        }
        gordas.push({ neuron_id: n.id, name: n.name, entries: vivas, groups });
      }
    }

    vencidas.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.entry_id < b.entry_id ? -1 : 1));
    gordas.sort((a, b) => b.entries - a.entries);
    return { expired: vencidas.length, sample: vencidas.slice(0, EXPIRED_SAMPLE), splits: gordas.slice(0, SPLIT_MAX_CANDIDATES) };
  }

  /**
   * Count the undated patterns, preferences, errors and debts, and — when
   * `write` — date the ones whose own text says when they happened.
   *
   * The ceiling is the first instant learn() ever stamped on this brain: an
   * entry written after that would carry a stamp, so a later date in an
   * undated entry is a deadline, not the day it was written. Day-precision
   * values are skipped when looking for it — they are earlier backfills, and
   * counting them would drag the ceiling back on every run.
   */
  private async backfillDates(write: boolean): Promise<{ undated: number; datable: number; written: number }> {
    const KINDS = ['patterns', 'preferences', 'errors', 'debts'] as const;
    const ids = await this.cortex.allIds();
    const neuronas: Neuron[] = [];
    let techo = '';
    for (const id of ids) {
      let n: Neuron | null;
      try {
        n = await readJSON<Neuron>(this.brain.paths.neuron(id));
      } catch {
        continue;   // corrupted: the integrity check reports it
      }
      if (!n) continue;
      neuronas.push(n);
      for (const v of Object.values(n.entry_dates || {})) {
        if (v && !isDayPrecision(v) && (!techo || v < techo)) techo = v;
      }
    }
    if (!techo) techo = today();

    let undated = 0, datable = 0, written = 0;
    for (const n of neuronas) {
      const nuevas: Record<string, string> = {};
      for (const k of KINDS) {
        for (const t of n[k] || []) {
          if (!t || n.entry_dates?.[entryId(t)]) continue;
          undated++;
          const dia = inferEntryDay(t, n.created, techo);
          if (!dia) continue;
          datable++;
          nuevas[entryId(t)] = dia;
        }
      }
      if (!write || Object.keys(nuevas).length === 0) continue;
      await updateJSON<Neuron>(this.brain.paths.neuron(n.id), current => {
        if (!current) return null;
        if (!current.entry_dates) current.entry_dates = {};
        let tocado = false;
        for (const [k, dia] of Object.entries(nuevas)) {
          if (current.entry_dates[k]) continue;   // stamped by someone else since the scan
          current.entry_dates[k] = dia;
          tocado = true;
          written++;
        }
        return tocado ? current : null;
      });
    }
    return { undated, datable, written };
  }

  /**
   * Fix what checkIntegrity() reports: dangling connection ids, synapse files
   * with a missing end, stale entry_dates / entry_status keys, manifest
   * counters. One line per fix. Corrupted files are left for a human.
   */
  private async repair(): Promise<string[]> {
    const done: string[] = [];
    const ids = await this.cortex.allIds();
    const existe = new Set(ids);

    // Synapses first: an orphan synapse also shows up as a dangling
    // connection on its surviving end, and disconnect() cleans both.
    for (const sid of await listJSONFiles(this.brain.paths.synapses)) {
      let synapse: Synapse | null;
      try {
        synapse = await readJSON<Synapse>(this.brain.paths.synapse(sid));
      } catch {
        continue;
      }
      if (!synapse || !Array.isArray(synapse.nodes) || synapse.nodes.length !== 2) continue;
      const faltan = synapse.nodes.filter(n => !existe.has(n));
      if (faltan.length === 0) continue;
      await deleteJSON(this.brain.paths.synapse(sid));
      for (const node of synapse.nodes) {
        if (!existe.has(node)) continue;
        await updateJSON<Neuron>(this.brain.paths.neuron(node), current => {
          if (!current) return null;
          const otro = synapse!.nodes[0] === node ? synapse!.nodes[1] : synapse!.nodes[0];
          if (!(current.connections || []).includes(otro)) return null;
          current.connections = current.connections.filter(c => c !== otro);
          return current;
        });
      }
      done.push(`Deleted orphan synapse ${sid} (missing: ${faltan.join(', ')})`);
    }

    for (const id of ids) {
      let neuron: Neuron | null;
      try {
        neuron = await readJSON<Neuron>(this.brain.paths.neuron(id));
      } catch {
        continue;   // corrupted: not ours to guess at
      }
      if (!neuron) continue;

      const rotas = (neuron.connections || []).filter(c => !existe.has(c));
      const vivos = liveEntryKeys(neuron);
      const fechasRancias = Object.keys(neuron.entry_dates || {}).filter(k => !vivos.has(k));
      const estadosRancios = Object.keys(neuron.entry_status || {}).filter(k => !vivos.has(k));
      if (rotas.length === 0 && fechasRancias.length === 0 && estadosRancios.length === 0) continue;

      await updateJSON<Neuron>(this.brain.paths.neuron(id), current => {
        if (!current) return null;
        if (rotas.length > 0) {
          current.connections = (current.connections || []).filter(c => existe.has(c));
        }
        if (fechasRancias.length > 0 && current.entry_dates) {
          for (const k of fechasRancias) delete current.entry_dates[k];
        }
        if (estadosRancios.length > 0 && current.entry_status) {
          for (const k of estadosRancios) delete current.entry_status[k];
        }
        return current;
      });
      for (const c of rotas) done.push(`Removed dangling connection ${id} → ${c}`);
      for (const k of fechasRancias) done.push(`Dropped stale entry_dates key ${k} from ${id}`);
      for (const k of estadosRancios) done.push(`Dropped stale entry_status key ${k} from ${id}`);
    }

    // Counters: the disk is the truth.
    const manifest = await this.brain.getManifest();
    const enDisco = {
      total_neurons: ids.length,
      total_synapses: (await listJSONFiles(this.brain.paths.synapses)).length,
      total_sessions: (await listJSONFiles(this.brain.paths.hippocampus)).length,
    };
    const cambios: Partial<typeof enDisco> = {};
    for (const k of Object.keys(enDisco) as Array<keyof typeof enDisco>) {
      if (manifest[k] !== enDisco[k]) {
        cambios[k] = enDisco[k];
        done.push(`Manifest ${k}: ${manifest[k]} → ${enDisco[k]}`);
      }
    }
    if (Object.keys(cambios).length > 0) await this.brain.updateManifest(cambios);

    return done;
  }
}
