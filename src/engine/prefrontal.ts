// ─── CRBRO Prefrontal Engine ─────────────────────────────────────
// Active context, hot topics, and global map (clustering + bridges)

import { readJSON, updateJSON, listJSONFiles, now } from '../utils/fs.js';
import { pendingId } from '../utils/hash.js';
import { redact } from './secrets.js';
import { readHeatState } from './heat.js';
import type { Brain } from './brain.js';
import type { ActiveContext, HotTopics, GlobalMap, Cluster, Bridge, Neuron, PendingTask } from '../types/index.js';

/** How many resolved items to keep around as a reminder. */
const RECENTLY_CLOSED_CAP = 15;

/** Normalise a stored entry: v1 brains hold plain strings. */
function toTask(entry: PendingTask | string): PendingTask {
  if (typeof entry === 'string') {
    return { id: pendingId(entry), text: entry, added: '' };
  }
  return entry;
}

function normalizeContext(ctx: ActiveContext | null): ActiveContext {
  return {
    last_session: '', active_topics: [], last_updated: now(), ...ctx,
    pending_tasks: (ctx?.pending_tasks || []).map(toTask),
    recently_closed: ctx?.recently_closed || [],
  };
}

/**
 * The one order open items are read in, whatever the scope: what is due
 * first, then the newest. A cap applied after it keeps what matters now; the
 * insertion order kept the oldest, so a boot without a project showed the
 * twelve items nobody had touched in months.
 */
export function sortOpenItems<T extends { due?: string; added?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    (a.due || '9999').localeCompare(b.due || '9999') || String(b.added || '').localeCompare(String(a.added || '')));
}

function projectView(ctx: ActiveContext, project?: string): ActiveContext {
  if (!project) return ctx;
  const visible = (t: PendingTask) => !t.project || t.project === project;
  return {
    ...ctx, active_topics: ctx.project_topics?.[project] || [],
    project_topics: ctx.project_topics?.[project] ? { [project]: ctx.project_topics[project] } : {},
    pending_tasks: sortOpenItems(ctx.pending_tasks.map(toTask).filter(visible)),
    recently_closed: (ctx.recently_closed || []).filter(visible),
  };
}

export class Prefrontal {
  constructor(private brain: Brain) {}

  // ─── Active Context ────────────────────────────────────────────

  /**
   * Get the current active context.
   */
  async getContext(project?: string): Promise<ActiveContext> {
    const ctx = await readJSON<ActiveContext>(this.brain.paths.activeContext());
    return projectView(normalizeContext(ctx), project);
  }

  /**
   * Update the active context.
   *
   * A call with nothing to change is a read: it returns the context and does
   * NOT touch the file. It used to rewrite last_updated on every read, so the
   * timestamp said "changed just now" about a context nobody had changed.
   */
  async updateContext(updates: {
    project?: string;
    due?: string;
    done_when?: string;
    set_topics?: string[];
    add_pending?: string;
    /**
     * Id of the item to close, or enough of its text to identify it.
     *
     * This used to filter by exact string equality, which made real pending
     * items unresolvable: they run to hundreds of characters with quotes and
     * file paths inside, and nothing ever reproduced one byte-for-byte. So
     * items accumulated forever and got repeated back to the user long after
     * they were done.
     */
    resolve_pending?: string;
    /** Drop one open item WITHOUT moving it to recently_closed. Same matcher as resolve_pending. */
    discard_pending?: string;
    /** Empty active_topics, pending_tasks and recently_closed. Runs before the other updates. */
    clear?: boolean;
  }): Promise<ActiveContext & { resolved: PendingTask[]; discarded: PendingTask[]; written: boolean; redacted?: string[]; added?: PendingTask }> {
    if (updates.project && !/^[a-zA-Z0-9_-]{1,100}$/.test(updates.project)) throw new Error('Invalid project id.');
    if (updates.due && (!/^\d{4}-\d{2}-\d{2}$/.test(updates.due) ||
      !Number.isFinite(Date.parse(updates.due)) || new Date(updates.due).toISOString().slice(0, 10) !== updates.due)) {
      throw new Error('Invalid due date; use a real YYYY-MM-DD calendar day.');
    }
    const hayCambio =
      updates.clear === true ||
      updates.set_topics !== undefined ||
      (updates.add_pending !== undefined && updates.add_pending !== '') ||
      (updates.resolve_pending !== undefined && updates.resolve_pending !== '') ||
      (updates.discard_pending !== undefined && updates.discard_pending !== '');

    if (!hayCambio) {
      return { ...await this.getContext(updates.project), resolved: [], discarded: [], written: false };
    }

    let resolved: PendingTask[] = [];
    let discarded: PendingTask[] = [];
    let redacted: string[] = [];
    let added: PendingTask | undefined;
    const saved = await updateJSON<ActiveContext>(this.brain.paths.activeContext(), current => {
    const ctx = normalizeContext(current);

    if (updates.clear) {
      if (updates.project) {
        delete ctx.project_topics?.[updates.project];
        ctx.pending_tasks = ctx.pending_tasks.map(toTask).filter(t => t.project !== updates.project);
        ctx.recently_closed = ctx.recently_closed?.filter(t => t.project !== updates.project);
      } else {
        ctx.active_topics = []; ctx.project_topics = {};
        ctx.pending_tasks = []; ctx.recently_closed = [];
      }
    }

    let tasks = ctx.pending_tasks.map(toTask);

    if (updates.set_topics) {
      if (updates.project) (ctx.project_topics ||= {})[updates.project] = updates.set_topics;
      else ctx.active_topics = updates.set_topics;
    }

    if (updates.add_pending) {
      // An open item is read back by crbro_boot in every session and copied
      // into compaction checkpoints: it goes through the same filter as learn.
      const filtrado = redact(updates.add_pending.trim());
      redacted = filtrado.found;
      const text = filtrado.text;
      const id = pendingId(updates.project ? `${updates.project}\n${text}` : text);
      const criterion = updates.done_when ? redact(updates.done_when) : undefined;
      redacted.push(...(criterion?.found || []));
      const existing = tasks.find(t => t.id === id);
      const metadata = {
        ...(updates.project ? { project: updates.project } : {}),
        ...(updates.due ? { due: updates.due } : {}),
        ...(criterion ? { done_when: criterion.text } : {}),
      };
      if (existing) Object.assign(existing, metadata);
      else tasks.push({ id, text, added: now(), status: 'open', ...metadata });
      added = { ...(existing ?? tasks[tasks.length - 1]) };
    }

    // Id, exact text, or a case-insensitive substring of at least 8 chars in
    // either direction — the same predicate for resolving and discarding.
    const matcher = (needleRaw: string) => {
      const needle = needleRaw.trim();
      const lower = needle.toLowerCase();
      return (t: PendingTask) => (!updates.project || !t.project || t.project === updates.project) && (
        t.id === needle ||
        t.text === needle ||
        (lower.length >= 8 &&
          (t.text.toLowerCase().includes(lower) || lower.includes(t.text.toLowerCase()))));
    };

    if (updates.resolve_pending) {
      const hit = matcher(updates.resolve_pending);
      resolved = tasks.filter(hit).map(t => ({ ...t, closed: now(), status: 'done' as const }));
      tasks = tasks.filter(t => !hit(t));

      if (resolved.length > 0) {
        ctx.recently_closed = [...resolved, ...(ctx.recently_closed || [])]
          .slice(0, RECENTLY_CLOSED_CAP);
      }
    }

    if (updates.discard_pending) {
      const hit = matcher(updates.discard_pending);
      discarded = tasks.filter(hit);
      tasks = tasks.filter(t => !hit(t));
    }

    ctx.pending_tasks = tasks;
    ctx.last_updated = now();
    return ctx;
    });
    return { ...projectView(saved!, updates.project), resolved, discarded, written: true,
      ...(redacted.length ? { redacted } : {}), ...(added ? { added } : {}) };
  }

  /**
   * Record which session was logged last. Nothing else in the context moves.
   * Before this, nothing ever wrote last_session, so boot reported null forever.
   */
  async setLastSession(sessionId: string): Promise<void> {
    await updateJSON<ActiveContext>(this.brain.paths.activeContext(), current => ({
      ...normalizeContext(current), last_session: sessionId, last_updated: now(),
    }));
  }

  // ─── Hot Topics ─────────────────────────────────────────────────

  /**
   * Get current hot topics.
   */
  async getHotTopics(limit: number = 15): Promise<HotTopics> {
    const ht = await readJSON<HotTopics>(this.brain.paths.hotTopics());
    if (!ht) {
      return { topics: [], last_recalculated: now() };
    }
    return {
      ...ht,
      topics: ht.topics.slice(0, limit),
    };
  }

  // ─── Global Map ────────────────────────────────────────────────

  /**
   * The global map — clusters of related neurons and bridges between domains.
   *
   * Computed live from the cortex and the connections on every call, and
   * never written to disk. The cached global_map.json it replaces was the one
   * file a maintenance dry run still rewrote, and it went stale between
   * rebuilds; a map that is always current costs one pass over the neurons.
   * `last_rebuilt` keeps its name so the GlobalMap shape does not change: it
   * is the moment this map was computed.
   */
  async getGlobalMap(): Promise<GlobalMap> {
    const ids = await listJSONFiles(this.brain.paths.cortex);
    const neurons: Neuron[] = [];
    // Heat lives in the derived heat state since 2.11; a neuron file keeps
    // the value it had when heat stopped being written into it.
    const calor = (await readHeatState(this.brain))?.neurons || {};

    for (const id of ids) {
      // 2.11 (C1): an unreadable neuron is skipped, not the end of maintenance or the map.
      let neuron: Neuron | null = null;
      try { neuron = await readJSON<Neuron>(this.brain.paths.neuron(id)); } catch { /* corrupt: skipped */ }
      if (!neuron) continue;
      const h = calor[neuron.id]?.heat;
      neurons.push(typeof h === 'number' ? { ...neuron, heat: h } : neuron);
    }

    // Build clusters by domain
    const domainGroups: Record<string, Neuron[]> = {};
    for (const neuron of neurons) {
      const domain = neuron.domain || 'uncategorized';
      if (!domainGroups[domain]) domainGroups[domain] = [];
      domainGroups[domain].push(neuron);
    }

    const clusters: Cluster[] = [];
    for (const [domain, domainNeurons] of Object.entries(domainGroups)) {
      const avgHeat = domainNeurons.reduce((sum, n) => sum + n.heat, 0) / domainNeurons.length;
      clusters.push({
        name: domain,
        nodes: domainNeurons.map(n => n.id),
        summary: `${domainNeurons.length} neurons — top: ${domainNeurons
          .sort((a, b) => b.heat - a.heat)
          .slice(0, 3)
          .map(n => n.name)
          .join(', ')}`,
        heat: Math.round(avgHeat * 1000) / 1000,
      });
    }

    // Find bridges — neurons that connect different domains
    const bridges: Bridge[] = [];
    for (const neuron of neurons) {
      if (!neuron.connections || neuron.connections.length === 0) continue;

      // Get connected neurons' domains
      const connectedDomains: Set<string> = new Set();
      const viaNodes: string[] = [];

      for (const connId of neuron.connections) {
        const connNeuron = neurons.find(n => n.id === connId);
        if (connNeuron && connNeuron.domain !== neuron.domain) {
          connectedDomains.add(connNeuron.domain);
          viaNodes.push(connId);
        }
      }

      if (connectedDomains.size > 0) {
        for (const targetDomain of connectedDomains) {
          // Avoid duplicate bridges
          const existingBridge = bridges.find(
            b => (b.from === neuron.domain && b.to === targetDomain) ||
                 (b.from === targetDomain && b.to === neuron.domain)
          );

          if (!existingBridge) {
            bridges.push({
              from: neuron.domain,
              to: targetDomain,
              via: viaNodes.filter(v => {
                const n = neurons.find(nn => nn.id === v);
                return n && n.domain === targetDomain;
              }),
              context: `Connected through ${neuron.name}`,
            });
          }
        }
      }
    }

    return {
      last_rebuilt: now(),
      clusters: clusters.sort((a, b) => b.heat - a.heat),
      bridges,
    };
  }
}
