// ─── CRBRO Cortex Engine ─────────────────────────────────────────
// Neuron CRUD — create, read, update, list neurons

import { readJSON, writeJSON, listJSONFiles, now } from '../utils/fs.js';
import { neuronId, inferNeuronType, toSnakeCase, isValidNeuronId } from '../utils/ids.js';
import type { Brain } from './brain.js';
import type { Neuron, NeuronType, Fact, Decision } from '../types/index.js';

export class Cortex {
  constructor(private brain: Brain) {}

  /**
   * Get a neuron by ID.
   */
  async get(id: string): Promise<Neuron | null> {
    const neuron = await readJSON<Neuron>(this.brain.paths.neuron(id));
    if (neuron) {
      // Touch — update access time and count
      neuron.last_accessed = now();
      neuron.access_count += 1;
      await writeJSON(this.brain.paths.neuron(id), neuron);
    }
    return neuron;
  }

  /**
   * Get a neuron by ID without updating access stats.
   */
  async peek(id: string): Promise<Neuron | null> {
    return readJSON<Neuron>(this.brain.paths.neuron(id));
  }

  /**
   * Find a neuron by name (fuzzy match against existing neurons).
   * Returns the best match or null.
   */
  async findByName(name: string): Promise<Neuron | null> {
    const ids = await listJSONFiles(this.brain.paths.cortex);
    const slug = toSnakeCase(name);

    // Exact match first
    for (const id of ids) {
      if (id.endsWith(`_${slug}`) || id === slug) {
        return this.peek(id);
      }
    }

    // Partial match
    for (const id of ids) {
      if (id.includes(slug) || slug.includes(id.replace(/^(project_|tech_|lang_|person_|domain_|process_)/, ''))) {
        return this.peek(id);
      }
    }

    return null;
  }

  /**
   * Create a new neuron.
   */
  async create(name: string, type: NeuronType, domain: string, summary?: string): Promise<Neuron> {
    const id = neuronId(name, type);

    const neuron: Neuron = {
      id,
      name,
      domain,
      type,
      created: now(),
      last_accessed: now(),
      access_count: 1,
      heat: 0.5, // Initial heat
      summary: summary || '',
      facts: [],
      decisions: [],
      patterns: [],
      preferences: [],
      connections: [],
      tags: [],
    };

    await writeJSON(this.brain.paths.neuron(id), neuron);

    // Update manifest count
    const manifest = await this.brain.getManifest();
    await this.brain.updateManifest({ total_neurons: manifest.total_neurons + 1 });

    return neuron;
  }

  /**
   * Learn — add a fact, decision, or pattern to a neuron.
   * If the neuron doesn't exist, creates it first.
   */
  async learn(
    topic: string,
    type: 'fact' | 'decision' | 'pattern' | 'preference',
    content: string,
    options?: {
      confidence?: number;
      domain?: string;
      rationale?: string;
      neuronType?: NeuronType;
    }
  ): Promise<{ neuron: Neuron; action: 'created' | 'updated' }> {
    // Try to find existing neuron
    let neuron = await this.findByName(topic);
    let action: 'created' | 'updated' = 'updated';

    if (!neuron) {
      // Create new neuron
      const nType = options?.neuronType || inferNeuronType(topic);
      const domain = options?.domain || 'general';
      neuron = await this.create(topic, nType, domain);
      action = 'created';
    }

    // Add content based on type
    switch (type) {
      case 'fact': {
        // Check for duplicate
        const isDuplicate = neuron.facts.some(
          f => f.text.toLowerCase() === content.toLowerCase()
        );
        if (!isDuplicate) {
          const fact: Fact = {
            text: content,
            confidence: options?.confidence ?? 1.0,
            added: now(),
            source: 'session',
          };
          neuron.facts.push(fact);
        }
        break;
      }
      case 'decision': {
        const decision: Decision = {
          text: content,
          date: now(),
          rationale: options?.rationale || '',
        };
        neuron.decisions.push(decision);
        break;
      }
      case 'pattern': {
        if (!neuron.patterns.includes(content)) {
          neuron.patterns.push(content);
        }
        break;
      }
      case 'preference': {
        if (!neuron.preferences.includes(content)) {
          neuron.preferences.push(content);
        }
        break;
      }
    }

    // Update access
    neuron.last_accessed = now();
    neuron.access_count += 1;

    // Update domain if provided and neuron was just using default
    if (options?.domain && neuron.domain === 'general') {
      neuron.domain = options.domain;
    }

    await writeJSON(this.brain.paths.neuron(neuron.id), neuron);
    return { neuron, action };
  }

  /**
   * List all neurons with optional filters.
   */
  async list(options?: {
    domain?: string;
    type?: NeuronType;
    min_heat?: number;
    limit?: number;
  }): Promise<Array<{
    id: string;
    name: string;
    domain: string;
    type: NeuronType;
    heat: number;
    last_accessed: string;
    facts_count: number;
  }>> {
    const ids = await listJSONFiles(this.brain.paths.cortex);
    const neurons: Array<{
      id: string;
      name: string;
      domain: string;
      type: NeuronType;
      heat: number;
      last_accessed: string;
      facts_count: number;
    }> = [];

    for (const id of ids) {
      const neuron = await readJSON<Neuron>(this.brain.paths.neuron(id));
      if (!neuron) continue;

      // Apply filters
      if (options?.domain && neuron.domain !== options.domain) continue;
      if (options?.type && neuron.type !== options.type) continue;
      if (options?.min_heat && neuron.heat < options.min_heat) continue;

      neurons.push({
        id: neuron.id,
        name: neuron.name,
        domain: neuron.domain,
        type: neuron.type,
        heat: neuron.heat,
        last_accessed: neuron.last_accessed,
        facts_count: neuron.facts.length,
      });
    }

    // Sort by heat (descending)
    neurons.sort((a, b) => b.heat - a.heat);

    // Apply limit
    const limit = options?.limit || 50;
    return neurons.slice(0, limit);
  }

  /**
   * Update a neuron's summary.
   */
  async updateSummary(id: string, summary: string): Promise<Neuron | null> {
    const neuron = await this.peek(id);
    if (!neuron) return null;

    neuron.summary = summary;
    neuron.last_accessed = now();
    await writeJSON(this.brain.paths.neuron(id), neuron);
    return neuron;
  }

  /**
   * Add tags to a neuron.
   */
  async addTags(id: string, tags: string[]): Promise<Neuron | null> {
    const neuron = await this.peek(id);
    if (!neuron) return null;

    for (const tag of tags) {
      if (!neuron.tags.includes(tag)) {
        neuron.tags.push(tag);
      }
    }
    await writeJSON(this.brain.paths.neuron(id), neuron);
    return neuron;
  }

  /**
   * Get all neuron IDs.
   */
  async allIds(): Promise<string[]> {
    return listJSONFiles(this.brain.paths.cortex);
  }

  /**
   * Count total neurons.
   */
  async count(): Promise<number> {
    const ids = await listJSONFiles(this.brain.paths.cortex);
    return ids.length;
  }
}
