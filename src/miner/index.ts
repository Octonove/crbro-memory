// ─── CRBRO Miner: Main Engine ─────────────────────────────────
// Scans directories for conversation artifacts and feeds
// extracted knowledge into CRBRO's cortex.

import { readdir, readFile, stat, writeFile, mkdir } from 'fs/promises';
import { join, basename, extname } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { extractContent, type ExtractedContent } from './extractor.js';
import { Brain } from '../engine/brain.js';
import { Cortex } from '../engine/cortex.js';
import type { MineResult } from './types.js';

export interface MinerConfig {
  /** Directories to scan for artifacts */
  scanDirs: string[];
  /** Minimum file size in bytes to consider */
  minFileSize: number;
  /** File extensions to include */
  extensions: string[];
  /** Patterns to exclude from scanning */
  excludePatterns: string[];
}

interface MinerState {
  mined_files: Record<string, string>; // filepath → "lastModified_size" hash
  last_run: string | null;
  total_mined: number;
}

export type { MineResult };

const DEFAULT_CONFIG: MinerConfig = {
  scanDirs: [],
  minFileSize: 200,
  extensions: ['.md', '.txt'],
  excludePatterns: [
    '.metadata.',
    '.resolved',
    '.tmp',
    'node_modules',
    '.git',
    'tempmediaStorage',
  ],
};

/**
 * Auto-detect IDE conversation directories on the system.
 */
export function detectScanDirs(): string[] {
  const home = homedir();
  const dirs: string[] = [];

  const candidates = [
    // Antigravity (Google Gemini)
    join(home, '.gemini', 'antigravity', 'brain'),
    // Cursor
    join(home, '.cursor', 'conversations'),
    // Windsurf
    join(home, '.windsurf', 'conversations'),
    // Claude Desktop (Windows)
    join(process.env.APPDATA || '', 'Claude', 'conversations'),
    // Claude Desktop (macOS)
    join(home, 'Library', 'Application Support', 'Claude', 'conversations'),
    // VS Code + Continue
    join(home, '.continue', 'sessions'),
  ];

  for (const dir of candidates) {
    if (dir && existsSync(dir)) {
      dirs.push(dir);
    }
  }

  return dirs;
}

/**
 * Main miner class — scans directories and feeds CRBRO.
 */
export class Miner {
  private brain: Brain;
  private cortex: Cortex;
  private config: MinerConfig;
  private statePath: string;

  constructor(config?: Partial<MinerConfig>) {
    this.brain = new Brain();
    this.cortex = new Cortex(this.brain);
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.statePath = join(this.brain.paths.root, 'miner_state.json');

    // Auto-detect scan dirs if none provided
    if (this.config.scanDirs.length === 0) {
      this.config.scanDirs = detectScanDirs();
    }
  }

  /**
   * Run the miner on all configured directories.
   */
  async mine(targetDir?: string): Promise<MineResult> {
    const result: MineResult = {
      scanned: 0,
      new_files: 0,
      neurons_created: 0,
      neurons_updated: 0,
      facts_added: 0,
      decisions_added: 0,
      technologies_found: [],
      errors: [],
    };

    // Load state
    const state = await this.loadState();

    // Determine which directories to scan
    const dirs = targetDir ? [targetDir] : this.config.scanDirs;

    if (dirs.length === 0) {
      result.errors.push('No scan directories found. Run `npx crbro-memory setup-miner` to configure.');
      return result;
    }

    const allTechs = new Set<string>();

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        result.errors.push(`Directory not found: ${dir}`);
        continue;
      }

      try {
        const files = await this.collectFiles(dir);
        
        for (const filePath of files) {
          result.scanned++;

          // Check if already mined (unchanged)
          const fileStat = await stat(filePath);
          const hash = `${fileStat.mtime.toISOString()}_${fileStat.size}`;
          
          if (state.mined_files[filePath] === hash) {
            continue; // Already mined, skip
          }

          try {
            const content = await readFile(filePath, 'utf-8');
            const extracted = extractContent(content, basename(filePath));
            
            // Feed into CRBRO
            const feedResult = await this.feedCortex(extracted, filePath);
            
            result.new_files++;
            result.neurons_created += feedResult.created;
            result.neurons_updated += feedResult.updated;
            result.facts_added += feedResult.facts;
            result.decisions_added += feedResult.decisions;
            
            for (const tech of extracted.technologies) {
              allTechs.add(tech);
            }

            // Mark as mined
            state.mined_files[filePath] = hash;
          } catch (err) {
            result.errors.push(`Error processing ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        result.errors.push(`Error scanning ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    result.technologies_found = [...allTechs];

    // Save state
    state.last_run = new Date().toISOString();
    state.total_mined += result.new_files;
    await this.saveState(state);

    return result;
  }

  /**
   * Recursively collect files matching the config criteria.
   */
  private async collectFiles(dir: string): Promise<string[]> {
    const results: string[] = [];

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        // Check exclusion patterns
        if (this.config.excludePatterns.some(p => entry.name.includes(p))) {
          continue;
        }

        if (entry.isDirectory()) {
          const subFiles = await this.collectFiles(fullPath);
          results.push(...subFiles);
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (!this.config.extensions.includes(ext)) continue;

          const fileStat = await stat(fullPath);
          if (fileStat.size < this.config.minFileSize) continue;

          results.push(fullPath);
        }
      }
    } catch {
      // Permission errors, etc. — skip silently
    }

    return results;
  }

  /**
   * Feed extracted content into CRBRO's cortex.
   */
  private async feedCortex(
    extracted: ExtractedContent,
    sourcePath: string,
  ): Promise<{ created: number; updated: number; facts: number; decisions: number }> {
    let created = 0;
    let updated = 0;
    let factsAdded = 0;
    let decisionsAdded = 0;

    // Create/update neurons for each detected technology
    for (const tech of extracted.technologies) {
      const neuronId = `tech_${tech.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
      try {
        const existing = await this.cortex.get(neuronId);
        if (!existing) {
          await this.cortex.learn(tech, 'fact', `Referenced in: ${basename(sourcePath)}`, {
            domain: 'conocimiento',
          });
          created++;
        }
      } catch {
        // Neuron might not exist yet
        try {
          await this.cortex.learn(tech, 'fact', `Referenced in: ${basename(sourcePath)}`, {
            domain: 'conocimiento',
          });
          created++;
        } catch { /* skip */ }
      }
    }

    // Create neurons from extracted topics (if substantial)
    for (const topic of extracted.topics.slice(0, 3)) {
      if (topic.length < 5) continue;
      
      try {
        const result = await this.cortex.learn(topic, 'fact', extracted.summary || `Mined from ${basename(sourcePath)}`, {
          domain: 'general',
        });
        if (result.action === 'created') created++;
        else updated++;
      } catch { /* skip duplicates */ }
    }

    // Add facts to first topic neuron
    if (extracted.topics.length > 0) {
      const primaryTopic = extracted.topics[0];
      
      for (const fact of extracted.facts.slice(0, 5)) {
        try {
          await this.cortex.learn(primaryTopic, 'fact', fact, {
            confidence: 0.7, // Lower confidence for auto-mined data
          });
          factsAdded++;
        } catch { /* skip */ }
      }

      for (const decision of extracted.decisions.slice(0, 3)) {
        try {
          await this.cortex.learn(primaryTopic, 'decision', decision, {
            rationale: `Auto-mined from ${basename(sourcePath)}`,
          });
          decisionsAdded++;
        } catch { /* skip */ }
      }
    }

    return { created, updated, facts: factsAdded, decisions: decisionsAdded };
  }

  /**
   * Load miner state from disk.
   */
  private async loadState(): Promise<MinerState> {
    try {
      if (existsSync(this.statePath)) {
        const raw = await readFile(this.statePath, 'utf-8');
        return JSON.parse(raw);
      }
    } catch { /* corrupt state — start fresh */ }

    return {
      mined_files: {},
      last_run: null,
      total_mined: 0,
    };
  }

  /**
   * Save miner state to disk.
   */
  private async saveState(state: MinerState): Promise<void> {
    const dir = this.brain.paths.root;
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(this.statePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  /**
   * Get miner status info.
   */
  async getStatus(): Promise<{
    configured_dirs: string[];
    detected_dirs: string[];
    state: MinerState;
  }> {
    return {
      configured_dirs: this.config.scanDirs,
      detected_dirs: detectScanDirs(),
      state: await this.loadState(),
    };
  }
}
