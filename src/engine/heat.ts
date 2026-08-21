// ─── CRBRO Heat Score Engine ─────────────────────────────────────
// Calculates relevance score based on frequency, recency, and connectivity

import type { Neuron, HotTopic, HotTopics } from '../types/index.js';
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

// ─── Heat Manager ────────────────────────────────────────────────

export class HeatEngine {
  constructor(private brain: Brain) {}

  /**
   * Recalculate heat scores for all neurons.
   * Returns updated hot topics list.
   */
  async recalculate(): Promise<HotTopics> {
    const ids = await listJSONFiles(this.brain.paths.cortex);

    // First pass — find maximums for normalization
    let maxAccess = 1;
    let maxConnections = 1;
    const neurons: Neuron[] = [];

    for (const id of ids) {
      const neuron = await readJSON<Neuron>(this.brain.paths.neuron(id));
      if (!neuron) continue;
      neurons.push(neuron);
      if (neuron.access_count > maxAccess) maxAccess = neuron.access_count;
      if (neuron.connections.length > maxConnections) maxConnections = neuron.connections.length;
    }

    // Second pass — calculate and update heat
    const hotTopics: HotTopic[] = [];

    for (const neuron of neurons) {
      const heat = calculateHeat(
        neuron.access_count,
        neuron.last_accessed,
        neuron.connections.length,
        maxAccess,
        maxConnections
      );

      // Only touch the file when the number actually moved. Rewriting all
      // neurons on every pass was pure churn — between two consecutive runs
      // not one of them changes — and each rewrite is a window in which a
      // concurrent write from another client gets clobbered.
      if (Math.abs((neuron.heat ?? 0) - heat) > 1e-9) {
        neuron.heat = heat;
        await writeJSON(this.brain.paths.neuron(neuron.id), neuron);
      } else {
        neuron.heat = heat;
      }

      hotTopics.push({
        id: neuron.id,
        name: neuron.name,
        heat,
        last_access: neuron.last_accessed,
        domain: neuron.domain,
      });
    }

    // Sort by heat descending
    hotTopics.sort((a, b) => b.heat - a.heat);

    // Save hot topics (top 20)
    const result: HotTopics = {
      topics: hotTopics.slice(0, 20),
      last_recalculated: now(),
    };

    await writeJSON(this.brain.paths.hotTopics(), result);
    return result;
  }
}
