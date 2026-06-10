import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { Synapses } from '../src/engine/synapses.js';

let root: string;
let brain: Brain;
let cortex: Cortex;
let synapses: Synapses;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-syn-'));
  brain = new Brain(root);
  await brain.initialize();
  cortex = new Cortex(brain);
  synapses = new Synapses(brain);
  await cortex.create('OctoChat', 'project', 'web');
  await cortex.create('Firebase', 'tech', 'infra');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('Synapses.connect', () => {
  it('creates a synapse and wires both neurons together', async () => {
    const { action, synapse } = await synapses.connect('project_octochat', 'tech_firebase', 'dependency', 'hosting');
    expect(action).toBe('created');
    expect(synapse.strength).toBe(0.5);

    const fromConns = await synapses.getConnections('project_octochat');
    expect(fromConns).toHaveLength(1);
    expect(fromConns[0].target_id).toBe('tech_firebase');
    expect(fromConns[0].target_name).toBe('Firebase');

    const manifest = await brain.getManifest();
    expect(manifest.total_synapses).toBe(1);
  });

  it('strengthens an existing synapse instead of duplicating it', async () => {
    await synapses.connect('project_octochat', 'tech_firebase', 'dependency');
    const { action, synapse } = await synapses.connect('tech_firebase', 'project_octochat', 'dependency');
    expect(action).toBe('strengthened');
    expect(synapse.strength).toBeCloseTo(0.6, 5);
    expect(synapse.co_access_count).toBe(2);

    const manifest = await brain.getManifest();
    expect(manifest.total_synapses).toBe(1); // not double-counted
  });
});

describe('Synapses.decay', () => {
  it('prunes a synapse whose strength falls below the threshold', async () => {
    await synapses.connect('project_octochat', 'tech_firebase', 'dependency');
    // Force the synapse old and weak so decay prunes it.
    const id = 'syn_firebase__octochat';
    const synPath = brain.paths.synapse(id);
    const raw = JSON.parse(await fs.readFile(synPath, 'utf-8'));
    raw.strength = 0.05;
    raw.last_co_access = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    await fs.writeFile(synPath, JSON.stringify(raw));

    const pruned = await synapses.decay();
    expect(pruned).toBe(1);
    expect(await synapses.count()).toBe(0);

    // Connection lists on both neurons are cleaned up.
    const conns = await synapses.getConnections('project_octochat');
    expect(conns).toHaveLength(0);
  });

  it('keeps a fresh, strong synapse', async () => {
    await synapses.connect('project_octochat', 'tech_firebase', 'dependency');
    const pruned = await synapses.decay();
    expect(pruned).toBe(0);
    expect(await synapses.count()).toBe(1);
  });
});
