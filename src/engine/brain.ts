// ─── CRBRO Brain Manager ─────────────────────────────────────────
// Core brain initialization, boot sequence, and path management

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readJSON, writeJSON, fileExists, now } from '../utils/fs.js';
import type { Manifest, BootResult, ActiveContext, HotTopics } from '../types/index.js';

const CRBRO_DIR = process.env['CRBRO_PATH'] || path.join(process.env['HOME'] || process.env['USERPROFILE'] || '.', '.crbro');
const MANIFEST_FILE = 'manifest.json';
const CRBRO_VERSION = '1.0.0';

// ─── Paths ───────────────────────────────────────────────────────

export class BrainPaths {
  readonly root: string;
  readonly cortex: string;
  readonly synapses: string;
  readonly hippocampus: string;
  readonly prefrontal: string;
  readonly archives: string;
  readonly search: string;

  constructor(rootDir?: string) {
    this.root = rootDir || CRBRO_DIR;
    this.cortex = path.join(this.root, 'cortex');
    this.synapses = path.join(this.root, 'synapses');
    this.hippocampus = path.join(this.root, 'hippocampus');
    this.prefrontal = path.join(this.root, 'prefrontal');
    this.archives = path.join(this.root, 'archives');
    this.search = path.join(this.root, '.search');
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

  searchIndex(): string {
    return path.join(this.search, 'orama.index.json');
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
   * Creates all directories and a fresh manifest.
   */
  async initialize(): Promise<Manifest> {
    // Create directories
    const dirs = [
      this.paths.cortex,
      this.paths.synapses,
      this.paths.hippocampus,
      this.paths.prefrontal,
      this.paths.archives,
      this.paths.search,
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
      license_key: null,
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
    await writeJSON(this.paths.activeContext(), emptyContext);

    const emptyHotTopics: HotTopics = {
      topics: [],
      last_recalculated: now(),
    };
    await writeJSON(this.paths.hotTopics(), emptyHotTopics);

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
      message: `CRBRO boot complete. ${this.manifest.total_neurons} neurons, ${this.manifest.total_synapses} synapses, ${this.manifest.total_sessions} sessions.`,
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
}
