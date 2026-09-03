// ─── The language model in the loop (1.15) ───────────────────────
//
// Two cheap levers close vocabulary gaps that no embedding model closes:
// aliases written at save time (the caller knows the synonyms) and several
// phrasings searched together at recall time. Neither costs disk or RAM.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex, normalizeKeys } from '../src/engine/cortex.js';
import { SearchEngine } from '../src/search/index.js';

const HETZNER = 'El VPS principal es un CX32 de Hetzner en Falkenstein.';

let root: string;
let cortex: Cortex;
let engine: SearchEngine;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-keys-'));
  const brain = new Brain(root);
  await brain.initialize();
  cortex = new Cortex(brain);
  engine = new SearchEngine(brain);
  await engine.init();
  cortex.setIndexer(n => engine.indexNeuron(n));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('keywords on facts', () => {
  it('a word that lives only in the keys finds the line, and the line shows without it', async () => {
    await cortex.learn('Infraestructura', 'fact', HETZNER, { keys: ['hosting', 'alojamiento', 'servidor web'] });
    const hits = await engine.search('alojamiento');
    expect(hits[0].matching_content).toBe(HETZNER);
    expect(hits[0].matching_content).not.toContain('alojamiento');
  });

  it('keys are stored with the fact, normalised and capped at eight', async () => {
    const r = await cortex.learn('Infraestructura', 'fact', 'PHP está fijado en 8.2.', {
      keys: [' Versión ', 'versión', 'lenguaje', '', 'a', 'b', 'c', 'd', 'e', 'f', 'g'],
    });
    const fact = r.neuron!.facts.find(f => f.text === 'PHP está fijado en 8.2.')!;
    expect(fact.keys).toEqual(['versión', 'lenguaje', 'a', 'b', 'c', 'd', 'e', 'f']);
    expect(normalizeKeys(undefined)).toEqual([]);
  });

  it('the same line again with new keys merges them instead of adding a sibling', async () => {
    await cortex.learn('Infraestructura', 'fact', 'Cloudflare gestiona el DNS.', { keys: ['dominios'] });
    const r = await cortex.learn('Infraestructura', 'fact', 'Cloudflare gestiona el DNS.', { keys: ['nombres de dominio'] });
    const facts = r.neuron!.facts.filter(f => f.text === 'Cloudflare gestiona el DNS.');
    expect(facts).toHaveLength(1);
    expect(facts[0].keys).toEqual(['dominios', 'nombres de dominio']);
    const hits = await engine.search('nombres de dominio');
    expect(hits[0]?.matching_content).toBe('Cloudflare gestiona el DNS.');
  });

  it('keys survive a reload of the index', async () => {
    await cortex.learn('Infraestructura', 'fact', HETZNER, { keys: ['hosting'] });
    await engine.persist();
    const again = new SearchEngine(new Brain(root));
    await again.init();
    const hits = await again.search('hosting');
    expect(hits[0]?.matching_content).toBe(HETZNER);
  });
});

describe('several phrasings at once', () => {
  it('one phrasing behaves exactly like search', async () => {
    await cortex.learn('Infraestructura', 'fact', HETZNER);
    expect(await engine.searchMany(['Hetzner'])).toEqual(await engine.search('Hetzner'));
    expect(await engine.searchMany(['', '  '])).toEqual([]);
  });

  it('a phrasing that matches rescues a question that does not', async () => {
    await cortex.learn('Infraestructura', 'fact', HETZNER);
    await cortex.learn('Blog', 'fact', 'Los artículos salen programados cada 3 días.');
    const solo = await engine.search('dónde están alojadas las webs');
    expect(solo.every(h => !h.matching_content.includes('Hetzner'))).toBe(true);
    const hits = await engine.searchMany(['dónde están alojadas las webs', 'servidor VPS', 'proveedor de hosting']);
    expect(hits[0].matching_content).toContain('Hetzner');
    expect(hits[0].relevance_score).toBeLessThanOrEqual(1);
  });

  it('a neuron ranked first by every phrasing scores 1.0', async () => {
    await cortex.learn('Infraestructura', 'fact', HETZNER);
    const hits = await engine.searchMany(['Hetzner', 'VPS Hetzner', 'Falkenstein']);
    expect(hits[0].relevance_score).toBe(1);
    expect(hits[0].confidence).toBe('strong');
  });
});
