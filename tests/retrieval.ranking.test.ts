// ─── Ranking inside the neuron (1.13) ────────────────────────────
//
// Measured on the blind retrieval benchmark before this: of 13 misses, 3
// were the neuron's HEADER chunk (its name, boosted ×2) speaking for the
// neuron, and 5 were the right neuron answering with a sibling fact. The
// header may rank a neuron; it must never be the answer while a live content
// chunk matched. And the top results carry the neuron's next best lines.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { SearchEngine } from '../src/search/index.js';

let root: string;
let brain: Brain;
let cortex: Cortex;
let engine: SearchEngine;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-rank-'));
  brain = new Brain(root);
  await brain.initialize();
  cortex = new Cortex(brain);
  engine = new SearchEngine(brain);
  await engine.init();
  cortex.setIndexer(n => engine.indexNeuron(n));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  delete process.env.CRBRO_SYNONYMS;
});

describe('the header never speaks for the neuron', () => {
  it('a query matching the neuron NAME still answers with a content chunk', async () => {
    // The name carries "facturacion" (boost ×2); only one fact does.
    await cortex.learn('facturacion-negocio', 'fact',
      'La facturación se lleva con Holded; las facturas salen el día 1 con vencimiento a 30 días.');
    await cortex.learn('facturacion-negocio', 'fact',
      'La tarifa por hora subió de 45 a 60 EUR en enero para clientes nuevos.');

    const hits = await engine.search('programa de facturación y plazos');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].matched_kind).not.toBe('header');
    expect(hits[0].matching_content).toContain('Holded');
  });

  it('a neuron whose only match is its name answers with a content line, not the name', async () => {
    // Every chunk carries the neuron name as a searchable field, so a
    // question that only hits the name still finds the neuron — and the
    // answer is a line of knowledge, never the label.
    await cortex.learn('Proyecto Zeta', 'fact', 'Nada aquí menciona el nombre del proyecto.');
    const hits = await engine.search('zeta');
    expect(hits.length).toBe(1);
    expect(hits[0].matched_kind).toBe('fact');
    expect(hits[0].confidence).toBe('strong');
  });

  it('a neuron with no content at all is the one case where the header answers', async () => {
    const n = await cortex.create('Proyecto Omega', 'project', 'general');
    await engine.indexNeuron(n);
    const hits = await engine.search('omega');
    expect(hits.length).toBe(1);
    expect(hits[0].matched_kind).toBe('header');
  });
});

describe('also_matched', () => {
  it('the top result carries the neuron\'s next best lines, without repeating the first', async () => {
    await cortex.learn('infraestructura', 'fact', 'El hosting principal es un VPS de Hetzner en Falkenstein.');
    await cortex.learn('infraestructura', 'fact', 'El hosting de las webs pequeñas es un compartido de SiteGround.');
    await cortex.learn('infraestructura', 'fact', 'Cloudflare gestiona el DNS de todo el hosting.');

    const hits = await engine.search('hosting');
    expect(hits.length).toBe(1);
    const extra = hits[0].also_matched || [];
    expect(extra.length).toBe(2);
    for (const e of extra) {
      expect(e.text).not.toBe(hits[0].matching_content);
      expect(e.kind).toBe('fact');
    }
  });

  it('only the head of the list pays for it', async () => {
    for (let i = 0; i < 6; i++) {
      await cortex.learn(`tema-${i}`, 'fact', `Nota ${i} sobre despliegue. Otra nota ${i} sobre despliegue.`);
      await cortex.learn(`tema-${i}`, 'fact', `Segunda nota ${i} sobre despliegue en producción.`);
    }
    const hits = await engine.search('despliegue', { limit: 6 });
    expect(hits.length).toBe(6);
    expect(hits.slice(0, 3).every(h => (h.also_matched || []).length > 0)).toBe(true);
    expect(hits.slice(3).every(h => h.also_matched === undefined)).toBe(true);
  });
});

describe('confidence', () => {
  it('a chunk covering the whole question is strong; a thin overlap is weak', async () => {
    await cortex.learn('email-marketing', 'fact',
      'El dominio de envío lleva SPF, DKIM y DMARC en p=quarantine desde marzo.');
    await cortex.learn('cocina', 'fact', 'El horno de leña alcanza cuatrocientos grados desde marzo.');

    const fuerte = await engine.search('SPF DKIM dominio envío');
    expect(fuerte[0].confidence).toBe('strong');
    expect(fuerte[0].matched_terms).toBeGreaterThanOrEqual(2);
    expect(fuerte[0].query_terms).toBe(4);

    // Only "marzo" overlaps: three terms asked, one covered.
    const debil = await engine.search('presupuesto anual aprobado marzo');
    const cocina = debil.find(h => h.name === 'cocina');
    expect(cocina?.confidence).toBe('weak');
  });
});

describe('synonyms', () => {
  it('an English question finds the Spanish fact, and counts as the same term', async () => {
    // The neuron name must not contain the query term: the name is a
    // searchable field on every chunk and would match on its own.
    await cortex.learn('Boletines', 'fact',
      'El correo saliente pasa por Brevo con la lista de suscriptores del blog.');

    const con = await engine.search('email saliente');
    expect(con.length).toBe(1);
    expect(con[0].matched_terms).toBe(2);
    expect(con[0].confidence).toBe('strong');

    process.env.CRBRO_SYNONYMS = '0';
    const sin = await engine.search('email saliente');
    expect(sin.length).toBe(1);          // "saliente" still matches
    expect(sin[0].matched_terms).toBe(1); // "email" alone does not
    expect(sin[0].confidence).toBe('weak');
  });
});
