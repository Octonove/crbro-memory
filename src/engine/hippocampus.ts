// ─── CRBRO Hippocampus Engine ────────────────────────────────────
// Session logging and memory formation

import { readJSON, writeJSON, listJSONFiles, deleteJSON, now, today } from '../utils/fs.js';
import { sessionId } from '../utils/ids.js';
import { redact, secretKinds } from './secrets.js';
import type { Brain } from './brain.js';
import type { SessionLog } from '../types/index.js';

const SESSION_PREFIX = 'session_';

/** Accept 'session_2026-09-03' or '2026-09-03'. */
function normalizeSessionId(ref: string): string {
  const t = (ref || '').trim();
  return t.startsWith(SESSION_PREFIX) ? t : `${SESSION_PREFIX}${t}`;
}

export class Hippocampus {
  constructor(private brain: Brain) {}

  /**
   * Log a session.
   *
   * The summary passes through redact() first: a session summary is prose the
   * assistant writes about what it did, and "rotated the token to ghp_..." is
   * exactly the sentence it writes. The kinds found come back (never the
   * values) so the caller can say a credential was stripped.
   */
  async logSession(data: {
    summary: string;
    topics_touched: string[];
    key_facts_added?: number;
    decisions_made?: number;
    new_neurons_created?: number;
    synapses_updated?: number;
  }): Promise<SessionLog & { redacted: string[] }> {
    const limpio = redact(data.summary);
    data = { ...data, summary: limpio.text };
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
      return { ...existing, redacted: limpio.found };
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

    return { ...session, redacted: limpio.found };
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

  /**
   * Which session summaries hold a credential. Only the sessions with hits,
   * only the kinds — the values never leave the file. Logs written before
   * 2.0 were never redacted, which is what this is for.
   */
  async auditSecrets(): Promise<Array<{ session_id: string; date: string; kinds: string[] }>> {
    const out: Array<{ session_id: string; date: string; kinds: string[] }> = [];
    for (const id of await listJSONFiles(this.brain.paths.hippocampus)) {
      const session = await readJSON<SessionLog>(this.brain.paths.session(id));
      if (!session) continue;
      const kinds = secretKinds(session.summary || '');
      if (kinds.length > 0) out.push({ session_id: session.session_id || id, date: session.date, kinds });
    }
    return out;
  }

  /**
   * Delete one session log, after copying it to quarantine — the same
   * "nothing is deleted outright" rule the cortex follows.
   */
  async forgetSession(sessionRef: string): Promise<{ session_id: string; removed: boolean; backup: string | null }> {
    const session_id = normalizeSessionId(sessionRef);
    const ruta = this.brain.paths.session(session_id);
    const log = await readJSON<SessionLog>(ruta);
    if (!log) return { session_id, removed: false, backup: null };

    const sello = now().replace(/[:.]/g, '-');
    const backup = `${this.brain.paths.quarantine}/${session_id}.${sello}.json`;
    await writeJSON(backup, log);
    await deleteJSON(ruta);

    const manifest = await this.brain.getManifest();
    await this.brain.updateManifest({ total_sessions: Math.max(0, manifest.total_sessions - 1) });

    return { session_id, removed: true, backup };
  }
}
