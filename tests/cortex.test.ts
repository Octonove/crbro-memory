import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';

let root: string;
let brain: Brain;
let cortex: Cortex;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-cortex-'));
  brain = new Brain(root);
  await brain.initialize();
  cortex = new Cortex(brain);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('Cortex.create', () => {
  it('creates a neuron and bumps the manifest count', async () => {
    const n = await cortex.create('OctoChat', 'project', 'web');
    expect(n.id).toBe('project_octochat');
    expect(n.access_count).toBe(1);
    const manifest = await brain.getManifest();
    expect(manifest.total_neurons).toBe(1);
  });
});

describe('Cortex.learn', () => {
  it('creates a neuron on first learn and reports the action', async () => {
    const { action, neuron } = await cortex.learn('Firebase', 'fact', 'Uses Firestore eur3');
    expect(action).toBe('created');
    expect(neuron.facts).toHaveLength(1);
    expect(neuron.facts[0].text).toBe('Uses Firestore eur3');
  });

  it('deduplicates identical facts case-insensitively', async () => {
    await cortex.learn('Firebase', 'fact', 'Region is eur3');
    const { neuron } = await cortex.learn('Firebase', 'fact', 'region is EUR3');
    expect(neuron.facts).toHaveLength(1);
  });

  it('appends a second distinct fact and marks the neuron updated', async () => {
    await cortex.learn('Firebase', 'fact', 'Region is eur3');
    const { action, neuron } = await cortex.learn('Firebase', 'fact', 'Auth is email/password');
    expect(action).toBe('updated');
    expect(neuron.facts).toHaveLength(2);
  });

  it('stores decisions, patterns and preferences in their own buckets', async () => {
    await cortex.learn('Firebase', 'decision', 'Use Cloud Functions for redemption', { rationale: 'security' });
    await cortex.learn('Firebase', 'pattern', 'Always validate server-side');
    const { neuron } = await cortex.learn('Firebase', 'preference', 'Prefer eur3 region');
    expect(neuron.decisions).toHaveLength(1);
    expect(neuron.decisions[0].rationale).toBe('security');
    expect(neuron.patterns).toContain('Always validate server-side');
    expect(neuron.preferences).toContain('Prefer eur3 region');
  });
});

describe('Cortex.list', () => {
  beforeEach(async () => {
    await cortex.create('Alpha', 'project', 'web', 's');
    await cortex.create('Beta', 'tech', 'infra', 's');
    await cortex.create('Gamma', 'project', 'web', 's');
  });

  it('filters by domain', async () => {
    const web = await cortex.list({ domain: 'web' });
    expect(web).toHaveLength(2);
  });

  it('filters by type', async () => {
    const tech = await cortex.list({ type: 'tech' });
    expect(tech).toHaveLength(1);
    expect(tech[0].name).toBe('Beta');
  });

  it('respects the limit', async () => {
    const limited = await cortex.list({ limit: 1 });
    expect(limited).toHaveLength(1);
  });
});

describe('Cortex.addTags', () => {
  it('adds tags without duplicating', async () => {
    await cortex.create('Firebase', 'tech', 'infra');
    await cortex.addTags('tech_firebase', ['a', 'b']);
    const n = await cortex.addTags('tech_firebase', ['b', 'c']);
    expect(n?.tags.sort()).toEqual(['a', 'b', 'c']);
  });

  it('returns null for a missing neuron', async () => {
    expect(await cortex.addTags('tech_nope', ['x'])).toBeNull();
  });
});

describe('Cortex.get vs peek', () => {
  it('get() increments access_count, peek() does not', async () => {
    await cortex.create('Firebase', 'tech', 'infra'); // access_count = 1
    await cortex.get('tech_firebase'); // -> 2
    const peeked = await cortex.peek('tech_firebase');
    expect(peeked?.access_count).toBe(2);
  });
});
