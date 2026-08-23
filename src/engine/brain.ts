// ─── CRBRO Brain Manager ─────────────────────────────────────────
// Core brain initialization, boot sequence, and path management

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readJSON, writeJSON, fileExists, listJSONFiles, now } from '../utils/fs.js';
import type { Manifest, BootResult, ActiveContext, HotTopics, Neuron, ProtocolDirective } from '../types/index.js';

const CRBRO_DIR = process.env['CRBRO_PATH'] || path.join(process.env['HOME'] || process.env['USERPROFILE'] || '.', '.crbro');
const MANIFEST_FILE = 'manifest.json';
// The brain FORMAT, not the release. It moves only when the on-disk layout
// changes in a way that needs a migration, which is why it has stayed at 1.0.0
// while the package went to 1.8. The running version is reported separately by
// crbro_status.
const CRBRO_VERSION = '1.0.0';

// ─── Paths ───────────────────────────────────────────────────────

export class BrainPaths {
  readonly root: string;
  readonly cortex: string;
  readonly synapses: string;
  readonly hippocampus: string;
  readonly prefrontal: string;
  readonly archives: string;
  /** Copies kept before anything is removed. Nothing is deleted outright. */
  readonly quarantine: string;
  /** One directory per shared space. Each one is a git repository. */
  readonly shared: string;
  readonly search: string;
  readonly prompts: string;

  constructor(rootDir?: string) {
    this.root = rootDir || CRBRO_DIR;
    this.cortex = path.join(this.root, 'cortex');
    this.synapses = path.join(this.root, 'synapses');
    this.hippocampus = path.join(this.root, 'hippocampus');
    this.prefrontal = path.join(this.root, 'prefrontal');
    this.archives = path.join(this.root, 'archives');
    this.quarantine = path.join(this.root, '.quarantine');
    this.shared = path.join(this.root, 'shared');
    this.search = path.join(this.root, '.search');
    this.prompts = path.join(this.root, 'prompts');
  }

  manifest(): string {
    return path.join(this.root, MANIFEST_FILE);
  }

  neuron(id: string): string {
    return path.join(this.cortex, `${id}.json`);
  }

  synapse(id: string): string {
    return path.join(this.synapses, `${id}.json`);
  }

  session(id: string): string {
    return path.join(this.hippocampus, `${id}.json`);
  }

  activeContext(): string {
    return path.join(this.prefrontal, 'active_context.json');
  }

  hotTopics(): string {
    return path.join(this.prefrontal, 'hot_topics.json');
  }

  globalMap(): string {
    return path.join(this.prefrontal, 'global_map.json');
  }

  /** Pre-v2 index. Kept only so the migration can delete it. */
  searchIndex(): string {
    return path.join(this.search, 'orama.index.json');
  }

  /** Chunk-level index (v2+). Separate filename so an old index is never loaded. */
  chunksIndex(): string {
    return path.join(this.search, 'chunks.index.json');
  }
}

// ─── Brain Manager ───────────────────────────────────────────────

export class Brain {
  private manifest: Manifest | null = null;
  readonly paths: BrainPaths;

  constructor(rootDir?: string) {
    this.paths = new BrainPaths(rootDir);
  }

  /**
   * Initialize the brain directory structure.
   *
   * Idempotent on purpose. This method is public API — scripts against the
   * dist call it before using the Cortex — and it used to overwrite the
   * manifest and the prefrontal files unconditionally, zeroing the counters
   * of a live brain with 1,186 neurons (nothing was lost, but boot reported
   * an empty brain until the manifest was rebuilt by hand). Now an existing
   * brain is left exactly as found; only what is missing gets created.
   */
  async initialize(): Promise<Manifest> {
    if (await fileExists(this.paths.manifest())) {
      const existente = await readJSON<Manifest>(this.paths.manifest());
      if (existente) {
        this.manifest = existente;
        return existente;
      }
      // Unreadable manifest: fall through and rebuild it, but never touch
      // prefrontal files that are still there.
    }

    // Create directories
    const dirs = [
      this.paths.cortex,
      this.paths.synapses,
      this.paths.hippocampus,
      this.paths.prefrontal,
      this.paths.archives,
      this.paths.quarantine,
      this.paths.shared,
      this.paths.search,
      this.paths.prompts,
    ];

    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }

    // Create manifest
    const manifest: Manifest = {
      version: CRBRO_VERSION,
      created: now(),
      owner: 'user',
      brain_path: this.paths.root,
      total_neurons: 0,
      total_synapses: 0,
      total_sessions: 0,
      last_boot: null,
      last_consolidation: null,
    };

    await writeJSON(this.paths.manifest(), manifest);
    this.manifest = manifest;

    // Create empty prefrontal files
    const emptyContext: ActiveContext = {
      last_session: '',
      active_topics: [],
      pending_tasks: [],
      last_updated: now(),
    };
    if (!(await fileExists(this.paths.activeContext()))) {
      await writeJSON(this.paths.activeContext(), emptyContext);
    }

    const emptyHotTopics: HotTopics = {
      topics: [],
      last_recalculated: now(),
    };
    if (!(await fileExists(this.paths.hotTopics()))) {
      await writeJSON(this.paths.hotTopics(), emptyHotTopics);
    }

    return manifest;
  }

  /**
   * Boot sequence — load manifest, verify integrity, return brain state.
   * If brain doesn't exist, initialize it first.
   */
  async boot(): Promise<BootResult> {
    const exists = await fileExists(this.paths.manifest());

    if (!exists) {
      // First boot — initialize
      const manifest = await this.initialize();
      return {
        status: 'initialized',
        total_neurons: 0,
        total_synapses: 0,
        total_sessions: 0,
        hot_topics: [],
        last_session: null,
        active_context: null,
        active_protocols: [],
        message: `CRBRO brain initialized at ${this.paths.root}. Ready for first session.`,
      };
    }

    // Load manifest
    this.manifest = await readJSON<Manifest>(this.paths.manifest());
    if (!this.manifest) {
      throw new Error('CRBRO: Manifest exists but could not be read.');
    }

    // Load hot topics
    const hotTopics = await readJSON<HotTopics>(this.paths.hotTopics());

    // Load active context
    const activeContext = await readJSON<ActiveContext>(this.paths.activeContext());

    // Load active protocols
    const activeProtocols = await this.loadProtocols();

    // Pending items, split into what is open and what was just closed.
    const openItems = (activeContext?.pending_tasks || []).map(t =>
      typeof t === 'string'
        ? { id: '', text: t, added: '' }
        : t
    );
    const recentlyClosed = activeContext?.recently_closed || [];

    // Self-heal the counters. The manifest is derived data: the cortex on
    // disk is the truth, and a manifest that says 0 while a thousand neuron
    // files sit right there (a reset, a crash, an older bug) makes boot lie
    // about the whole brain. Three readdirs per boot buy an honest answer.
    const enDisco = {
      total_neurons: (await listJSONFiles(this.paths.cortex)).length,
      total_synapses: (await listJSONFiles(this.paths.synapses)).length,
      total_sessions: (await listJSONFiles(this.paths.hippocampus)).length,
    };
    if (this.manifest.total_neurons !== enDisco.total_neurons ||
        this.manifest.total_synapses !== enDisco.total_synapses ||
        this.manifest.total_sessions !== enDisco.total_sessions) {
      this.manifest.total_neurons = enDisco.total_neurons;
      this.manifest.total_synapses = enDisco.total_synapses;
      this.manifest.total_sessions = enDisco.total_sessions;
    }

    // Update boot timestamp
    this.manifest.last_boot = now();
    await writeJSON(this.paths.manifest(), this.manifest);

    return {
      status: 'ok',
      total_neurons: this.manifest.total_neurons,
      total_synapses: this.manifest.total_synapses,
      total_sessions: this.manifest.total_sessions,
      hot_topics: hotTopics?.topics || [],
      last_session: activeContext?.last_session || null,
      active_context: activeContext,
      active_protocols: activeProtocols,
      open_items: openItems,
      recently_closed: recentlyClosed,
      message:
        `CRBRO boot complete. ${this.manifest.total_neurons} neurons, ${this.manifest.total_synapses} synapses, ` +
        `${this.manifest.total_sessions} sessions. ${activeProtocols.length} active protocol(s). ` +
        `${openItems.length} open item(s), ${recentlyClosed.length} recently closed.`,
    };
  }

  /**
   * Get the current manifest.
   */
  async getManifest(): Promise<Manifest> {
    if (!this.manifest) {
      this.manifest = await readJSON<Manifest>(this.paths.manifest());
      if (!this.manifest) {
        throw new Error('CRBRO: Brain not initialized. Call boot() first.');
      }
    }
    return this.manifest;
  }

  /**
   * Update the manifest counters.
   */
  async updateManifest(updates: Partial<Manifest>): Promise<void> {
    const manifest = await this.getManifest();
    Object.assign(manifest, updates);
    await writeJSON(this.paths.manifest(), manifest);
    this.manifest = manifest;
  }

  /**
   * Load all active protocol neurons and return as directives.
   * Protocols are neurons with type 'protocol' — their facts
   * become enforcement instructions injected at boot.
   */
  async loadProtocols(): Promise<ProtocolDirective[]> {
    const cortexDir = this.paths.cortex;
    const protocols: ProtocolDirective[] = [];

    try {
      const files = await fs.readdir(cortexDir);

      for (const file of files) {
        if (!file.startsWith('protocol_') || !file.endsWith('.json')) continue;

        const neuron = await readJSON<Neuron>(path.join(cortexDir, file));
        if (!neuron) continue;

        // Extract priority from tags (e.g., "priority:10")
        const priorityTag = neuron.tags.find(t => t.startsWith('priority:'));
        const priority = priorityTag ? parseInt(priorityTag.split(':')[1]) : 5;

        // Extract source from tags (e.g., "source:zero-deck")
        const sourceTag = neuron.tags.find(t => t.startsWith('source:'));
        const source = sourceTag ? sourceTag.split(':')[1] : 'manual';

        // Combine the ACTIVE facts into a single instruction block. Without
        // the filter, correcting a protocol via supersedes injected both the
        // old and the new wording into every session, side by side.
        const instructions = neuron.facts
          .filter(f => !f.status || f.status === 'active')
          .map(f => f.text)
          .join('\n\n');

        if (instructions.trim()) {
          protocols.push({
            id: neuron.id,
            name: neuron.name,
            priority,
            instructions,
            source,
          });
        }
      }
    } catch {
      // Cortex dir may not exist yet — return empty
    }

    // Sort by priority (highest first)
    protocols.sort((a, b) => b.priority - a.priority);
    return protocols;
  }
}
