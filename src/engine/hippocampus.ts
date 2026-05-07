// ─── CRBRO Hippocampus Engine ────────────────────────────────────
// Session logging and memory formation

import { readJSON, writeJSON, listJSONFiles, now, today } from '../utils/fs.js';
import { sessionId } from '../utils/ids.js';
import type { Brain } from './brain.js';
import type { SessionLog } from '../types/index.js';

export class Hippocampus {
  constructor(private brain: Brain) {}

  /**
   * Log a session.
   */
  async logSession(data: {
    summary: string;
    topics_touched: string[];
    key_facts_added?: number;
    decisions_made?: number;
    new_neurons_created?: number;
    synapses_updated?: number;
  }): Promise<SessionLog> {
    const id = sessionId();

    // Check if session for today already exists — append to it
    let existing = await readJSON<SessionLog>(this.brain.paths.session(id));

    if (existing) {
      // Append to existing session
      existing.summary += `\n---\n${data.summary}`;
      existing.topics_touched = [...new Set([...existing.topics_touched, ...data.topics_touched])];
      existing.key_facts_added += data.key_facts_added || 0;
      existing.decisions_made += data.decisions_made || 0;
      existing.new_neurons_created += data.new_neurons_created || 0;
      existing.synapses_updated += data.synapses_updated || 0;
      await writeJSON(this.brain.paths.session(id), existing);
      return existing;
    }

    // Create new session log
    const session: SessionLog = {
      session_id: id,
      date: today(),
      duration_estimate: 'unknown',
      topics_touched: data.topics_touched,
      summary: data.summary,
      key_facts_added: data.key_facts_added || 0,
      decisions_made: data.decisions_made || 0,
      new_neurons_created: data.new_neurons_created || 0,
      synapses_updated: data.synapses_updated || 0,
    };

    await writeJSON(this.brain.paths.session(id), session);

    // Update manifest
    const manifest = await this.brain.getManifest();
    await this.brain.updateManifest({ total_sessions: manifest.total_sessions + 1 });

    return session;
  }

  /**
   * List recent sessions.
   */
  async listSessions(limit: number = 10): Promise<SessionLog[]> {
    const ids = await listJSONFiles(this.brain.paths.hippocampus);
    const sessions: SessionLog[] = [];

    for (const id of ids) {
      const session = await readJSON<SessionLog>(this.brain.paths.session(id));
      if (session) sessions.push(session);
    }

    // Sort by date descending (newest first)
    sessions.sort((a, b) => b.date.localeCompare(a.date));

    return sessions.slice(0, limit);
  }

  /**
   * Get today's session log.
   */
  async getToday(): Promise<SessionLog | null> {
    const id = sessionId();
    return readJSON<SessionLog>(this.brain.paths.session(id));
  }
}
