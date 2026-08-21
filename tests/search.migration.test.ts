// ─── Migration: an old on-disk index must never break recall ─────
//
// Orama's `load()` does not throw when the stored schema differs from the live
// one — it silently replaces the live schema with the old one. So the previous
// try/catch never fired, every later search failed with `Invalid property
// name`, and because the same file was reloaded on every boot it never healed.
// For anyone upgrading, that is search broken permanently.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { SearchEngine } from '../src/search/index.js';
import { fileExists } from '../src/utils/fs.js';

let root: string;
let brain: Brain;
let cortex: Cortex;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-mig-'));
  brain = new Brain(root);
  await brain.initialize();
  cortex = new Cortex(brain);
  await cortex.learn('OctoChat', 'fact', 'OctoChat usa Gemini para capturar leads.');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('search index migration', () => {
  it('rebuilds instead of loading a pre-v2 index', async () => {
    // A v1 index with the old schema, as an upgrading user would have on disk.
    await fs.mkdir(brain.paths.search, { recursive: true });
    await fs.writeFile(
      brain.paths.searchIndex(),
      JSON.stringify({ index: {}, docs: {}, sorting: {}, language: 'english' }),
      'utf-8',
    );

    const engine = new SearchEngine(brain);
    await expect(engine.init()).resolves.not.toThrow();

    const results = await engine.search('OctoChat');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].neuron_id).toBe('project_octochat');

    // The new index exists and the dead 25 MB file is gone.
    expect(await fileExists(brain.paths.chunksIndex())).toBe(true);
    expect(await fileExists(brain.paths.searchIndex())).toBe(false);
  });

  it('rebuilds when the stored version is newer or unknown', async () => {
    await fs.mkdir(brain.paths.search, { recursive: true });
    await fs.writeFile(
      brain.paths.chunksIndex(),
      JSON.stringify({ v: 999, data: { nonsense: true } }),
      'utf-8',
    );

    const engine = new SearchEngine(brain);
    await expect(engine.init()).resolves.not.toThrow();
    const results = await engine.search('OctoChat');
    expect(results.length).toBeGreaterThan(0);
  });

  it('survives a corrupted index file', async () => {
    await fs.mkdir(brain.paths.search, { recursive: true });
    await fs.writeFile(brain.paths.chunksIndex(), '{ this is not json', 'utf-8');

    const engine = new SearchEngine(brain);
    await expect(engine.init()).resolves.not.toThrow();
    const results = await engine.search('OctoChat');
    expect(results.length).toBeGreaterThan(0);
  });

  it('reads a v1 neuron file without lifecycle fields', async () => {
    // Facts written before this version have no id and no status.
    const legacy = {
      id: 'project_legacy',
      name: 'Legacy',
      domain: 'general',
      type: 'project',
      created: '2026-01-01T00:00:00.000Z',
      last_accessed: '2026-01-01T00:00:00.000Z',
      access_count: 1,
      heat: 0.5,
      summary: '',
      facts: [{ text: 'Un hecho antiguo sobre pastelitos', confidence: 1, added: '2026-01-01T00:00:00.000Z', source: 'session' }],
      decisions: [],
      patterns: [],
      preferences: [],
      connections: [],
      tags: [],
    };
    await fs.writeFile(brain.paths.neuron('project_legacy'), JSON.stringify(legacy), 'utf-8');

    const engine = new SearchEngine(brain);
    await engine.rebuild();

    const results = await engine.search('pastelitos');
    expect(results[0].neuron_id).toBe('project_legacy');
    expect(results[0].matching_content).toContain('pastelitos');
  });
});
