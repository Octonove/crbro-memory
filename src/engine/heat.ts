// ─── CRBRO Heat Score Engine ─────────────────────────────────────
// Calculates relevance score based on frequency, recency, and connectivity

import type { Neuron, HotTopic, HotTopics } from '../types/index.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readJSON, writeJSON, listJSONFiles, now } from '../utils/fs.js';
import type { Brain } from './brain.js';

// Weight constants
const WEIGHT_FREQUENCY = 0.35;
const WEIGHT_RECENCY = 0.40;
const WEIGHT_CONNECTIVITY = 0.25;

/**
 * Calculate recency score (0.0 - 1.0) based on last access date.
 */
export function recencyScore(lastAccessed: string): number {
  const lastDate = new Date(lastAccessed).getTime();
  const nowMs = Date.now();
  const diffDays = (nowMs - lastDate) / (1000 * 60 * 60 * 24);

  if (diffDays < 1) return 1.0;       // Today
  if (diffDays < 7) return 0.8;       // This week
  if (diffDays < 30) return 0.5;      // This month
  if (diffDays < 90) return 0.2;      // Last 3 months
  return 0.05;                         // Older
}

/**
 * Calculate frequency score (0.0 - 1.0) normalized against max access count.
 */
export function frequencyScore(accessCount: number, maxAccessCount: number): number {
  if (maxAccessCount === 0) return 0;
  return Math.min(1.0, accessCount / maxAccessCount);
}

/**
 * Calculate connectivity score (0.0 - 1.0) based on number of connections.
 */
export function connectivityScore(connectionCount: number, maxConnections: number): number {
  if (maxConnections === 0) return 0;
  return Math.min(1.0, connectionCount / maxConnections);
}

/**
 * Calculate the heat score for a neuron.
 */
export function calculateHeat(
  accessCount: number,
  lastAccessed: string,
  connectionCount: number,
  maxAccessCount: number,
  maxConnections: number
): number {
  const freq = frequencyScore(accessCount, maxAccessCount);
  const rec = recencyScore(lastAccessed);
  const conn = connectivityScore(connectionCount, maxConnections);

  const heat = (freq * WEIGHT_FREQUENCY) + (rec * WEIGHT_RECENCY) + (conn * WEIGHT_CONNECTIVITY);

  // Round to 3 decimal places
  return Math.round(heat * 1000) / 1000;
}

/// ─── Heat Manager ────────────────────────────────────────────────
//
// Heat is derived data: access count, last access and connections, scaled
// against the brain's maxima. Until 2.11 it was recomputed by reading and
// parsing every neuron on every consolidate (~9 MB on the reference brain) and
// written back INTO each neuron whose number moved — rewriting up to 1 MB of
// primary data for one derived number, a whole-brain pass whenever the maximum
// moved.
//
// Now it lives in one derived, rebuildable file, prefrontal/heat_state.json:
// per neuron the inputs, the file's mtime and size, and the heat. A pass stats
// every neuron and re-reads only the ones whose file changed since the last
// pass. Neuron files are no longer rewritten for heat; the `heat` they carry is
// left exactly as it is, so a previous version reading the brain keeps
// working. Delete the state file and the next pass rebuilds it.

export interface HeatStateEntry {
  heat: number;
  access_count: number;
  last_accessed: string;
  connections: number;
  name: string;
  domain: string;
  /** Size and mtime of the neuron file the inputs were read from. */
  size: number;
  mtime: number;
}

export interface HeatState {
  version: 1;
  computed_at: string;
  neurons: Record<string, HeatStateEntry>;
}

export function heatStatePath(brain: Brain): string {
  return path.join(brain.paths.prefrontal, 'heat_state.json');
}

/** The derived heat state, or null when never computed or unreadable (it is rebuilt then). */
export async function readHeatState(brain: Brain): Promise<HeatState | null> {
  try {
    const s = await readJSON<HeatState>(heatStatePath(brain));
    return s && s.version === 1 && s.neurons && typeof s.neurons === 'object' ? s : null;
  } catch {
    return null;
  }
}

export class HeatEngine {
  constructor(private brain: Brain) {}

  /** Neuron files the last pass could not parse: skipped, never fatal. */
  lastUnreadable: string[] = [];
  /** How many neuron files the last pass actually read (the rest came from the state). */
  lastRead = 0;

  /**
   * Recalculate heat scores for all neurons.
   * Returns updated hot topics list.
   */
  async recalculate(): Promise<HotTopics> {
    const ids = await listJSONFiles(this.brain.paths.cortex);
    const previo = (await readHeatState(this.brain))?.neurons || {};
    const entradas: Record<string, HeatStateEntry> = {};
    const ilegibles: string[] = [];
    let leidas = 0;

    // First pass — inputs: from the state when the file has not changed,
    // from the file otherwise.
    let maxAccess = 1;
    let maxConnections = 1;
    for (const id of ids) {
      const file = this.brain.paths.neuron(id);
      let st;
      try { st = await fs.stat(file); } catch { continue; }
      const antes = previo[id];
      let e: HeatStateEntry;
      if (antes && antes.mtime === st.mtimeMs && antes.size === st.size) {
        e = { ...antes };
      } else {
        let neuron: Neuron | null;
        try {
          neuron = await readJSON<Neuron>(file);
        } catch {
          ilegibles.push(id);   // corrupted: skipped, the integrity check names it
          continue;
        }
        if (!neuron) continue;
        leidas++;
        e = {
          heat: 0,
          access_count: neuron.access_count || 0,
          last_accessed: neuron.last_accessed || neuron.created || '',
          connections: (neuron.connections || []).length,
          name: neuron.name || id,
          domain: neuron.domain || 'general',
          size: st.size,
          mtime: st.mtimeMs,
        };
      }
      entradas[id] = e;
      if (e.access_count > maxAccess) maxAccess = e.access_count;
      if (e.connections > maxConnections) maxConnections = e.connections;
    }

    // Second pass — calculate heat
    const hotTopics: HotTopic[] = [];
    for (const [id, e] of Object.entries(entradas)) {
      e.heat = calculateHeat(e.access_count, e.last_accessed, e.connections, maxAccess, maxConnections);
      hotTopics.push({ id, name: e.name, heat: e.heat, last_access: e.last_accessed, domain: e.domain });
    }

    // Sort by heat descending
    hotTopics.sort((a, b) => b.heat - a.heat || (a.id < b.id ? -1 : 1));

    const cuando = now();
    const estado: HeatState = { version: 1, computed_at: cuando, neurons: entradas };
    await writeJSON(heatStatePath(this.brain), estado, { pretty: false });

    // Save hot topics (top 20)
    const result: HotTopics = {
      topics: hotTopics.slice(0, 20),
      last_recalculated: cuando,
    };

    await writeJSON(this.brain.paths.hotTopics(), result);
    this.lastUnreadable = ilegibles;
    this.lastRead = leidas;
    return result;
  }
}
