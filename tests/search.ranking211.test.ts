// ─── Ranking and labels (2.11) ───────────────────────────────────
//
// S1/B2  confidence and the numbers beside it come from the same row
// B5/S2  also_matched holds each entry once
// B6     relevance_score is on a 0–1 scale in every mode
// B9     a term's ceiling is its best content hit, not a header
// B11    the bound project is a boost, not a tier above everything
// B4     breadth counts keyword evidence, one per entry
// idea 2 no_answer when nothing clears the evidence bar
// idea 3 one neuron cannot take every rank
// B12    long entries are searched and returned by part

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { SearchEngine, splitParts } from '../src/search/index.js';
import { factId } from '../src/utils/hash.js';

let root: string; let brain: Brain; let engine: SearchEngine; let cortex: Cortex;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-rank211-'));
  brain = new Brain(root); await brain.initialize();
  cortex = new Cortex(brain); engine = new SearchEngine(brain); await engine.init();
  cortex.setIndexer(n => engine.indexNeuron(n));
  process.env.CRBRO_RECENCY = '0';
});
afterEach(async () => {
  delete process.env.CRBRO_RECENCY;
  delete process.env.CRBRO_NO_ANSWER;
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

/** Write a neuron file directly (no learn-time checks), then index it. */
async function put(id: string, name: string, facts: string[], extra: Record<string, unknown> = {}) {
  const day = '2026-06-01T10:00:00.000Z';
  const n = {
    id, name, domain: 'general', type: 'project', created: day, last_accessed: day, access_count: 1, heat: 0.5, summary: '',
    facts: facts.map(text => ({ text, confidence: 0.9, added: day, source: 'test', id: factId(text) })),
    decisions: [], patterns: [], preferences: [], connections: [], tags: [], errors: [], debts: [], ...extra,
  };
  await fs.writeFile(brain.paths.neuron(id), JSON.stringify(n));
  await engine.indexNeuron(n as any);
}

describe('S1/B2: the label and the numbers come from one row', () => {
  it('with several phrasings, a strong row is shown with its own counts', async () => {
    await put('project_vps', 'VPS', ['El VPS de Hetzner está en Falkenstein y tiene 16 GB.']);
    const hits = await engine.searchMany(['dónde está el servidor principal alojado ahora mismo', 'VPS Hetzner']);
    const r = hits[0];
    expect(r.neuron_id).toBe('project_vps');
    expect(r.confidence).toBe('strong');
    // The numbers are the strong row's: 2 of 2, not 1 of 6.
    expect(r.matched_terms! / r.query_terms!).toBeGreaterThanOrEqual(0.5);
  });

  it('never labels strong a row whose own counts are weak', async () => {
    await put('project_a', 'Alfa', ['El despliegue de Alfa usa el puerto 8443 y un balanceador.']);
    await put('project_b', 'Beta', ['La tienda Beta vende cerámica artesanal de Talavera.']);
    const hits = await engine.searchMany(['cerámica Talavera', 'despliegue puerto balanceador certificado renovación automática']);
    for (const h of hits) {
      const strongByCounts = (h.query_terms ?? 0) <= 1 ? (h.matched_terms ?? 0) >= 1
        : (h.matched_terms ?? 0) >= 2 && (h.matched_terms ?? 0) / (h.query_terms ?? 1) >= 0.5;
      if (h.semantic_score === undefined) expect(h.confidence === 'strong').toBe(strongByCounts);
    }
  });
});

describe('B5: also_matched holds each entry once', () => {
  it('two phrasings whose best lines differ do not repeat a line', async () => {
    await put('project_x', 'Infra', [
      'El certificado TLS se renueva con certbot cada 60 días.',
      'El balanceador reparte el tráfico entre dos nodos.',
      'Los nodos del balanceador usan Ubuntu 24.04.',
      'Certbot deja los certificados en /etc/letsencrypt.',
    ]);
    const hits = await engine.searchMany(['certificado certbot renovación', 'balanceador nodos tráfico']);
    const r = hits[0];
    const ids = (r.also_matched || []).map(a => a.entry_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(r.entry_id);
  });
});

describe('B6: relevance_score is on one scale', () => {
  it('a full match scores 1 alone and with phrasings; a partial one less', async () => {
    await put('project_h', 'Hosting', ['El VPS principal es un CX32 de Hetzner en Falkenstein.']);
    const solo = await engine.search('Hetzner Falkenstein');
    expect(solo[0].relevance_score).toBeCloseTo(1, 2);
    const many = await engine.searchMany(['Hetzner Falkenstein', 'CX32 Hetzner']);
    expect(many[0].relevance_score).toBeCloseTo(1, 2);
    const partial = await engine.search('Hetzner Kubernetes Terraform');
    expect(partial[0].relevance_score).toBeLessThan(0.5);
  });
});

describe('B9: a header carrying the word does not set the term\'s ceiling', () => {
  it('a content line matching a term scores as a full term even when a neuron name has it', async () => {
    // A neuron whose only hit is its header (name), and a day log that repeats the word.
    await put('project_cloudflare', 'Cloudflare', []);
    await engine.indexSession({ session_id: 'session_2026-06-02', date: '2026-06-02', summary: 'Cloudflare cloudflare Cloudflare: hoy se habló de Cloudflare.' });
    await put('project_dns', 'DNS', ['Cloudflare gestiona el DNS de todo el portfolio.']);
    const hits = await engine.search('cloudflare');
    const dns = hits.find(h => h.neuron_id === 'project_dns')!;
    expect(dns.relevance_score).toBeCloseTo(1, 2);
  });
});

describe('B11: the project is a boost, not a tier', () => {
  it('a strong global match stays above a project neuron matching one word', async () => {
    await put('project_alpha', 'Alpha', ['En Alpha el despliegue va por FTP.']);
    await put('tech_tls', 'TLS', ['La renovación del certificado TLS del balanceador se hace con certbot.']);
    const hits = await engine.search('renovación certificado TLS balanceador despliegue', { preferNeurons: ['project_alpha'] });
    expect(hits[0].neuron_id).toBe('tech_tls');
    expect(hits.map(h => h.neuron_id)).toContain('project_alpha');
  });

  it('still decides a near tie in the project\'s favour', async () => {
    await put('project_alpha', 'Alpha', ['El despliegue usa puerto 8443.']);
    await put('project_beta', 'Beta', ['El despliegue usa puerto 9443.']);
    const hits = await engine.search('despliegue puerto', { preferNeurons: ['project_beta'] });
    expect(hits[0].neuron_id).toBe('project_beta');
  });
});

describe('idea 2: no answer', () => {
  it('a question nothing covers returns one weak row and no_answer', async () => {
    await put('project_a', 'Recetas', ['La receta de la tarta lleva tres huevos.']);
    await put('project_b', 'Viajes', ['El viaje a Lisboa salió en marzo.']);
    await put('project_c', 'Tienda', ['La tienda online abre a las nueve.']);
    const r = await engine.searchManyWithStats(['horario del gimnasio municipal los domingos tienda'], { limit: 5 });
    expect(r.no_answer).toBe(true);
    expect(r.results.length).toBe(1);
    expect(r.results[0].confidence).toBe('weak');
    expect(r.results[0].also_matched).toBeUndefined();
  });

  it('a covered question has no flag, and CRBRO_NO_ANSWER=0 turns the level off', async () => {
    await put('project_a', 'Recetas', ['La receta de la tarta lleva tres huevos.']);
    const ok = await engine.searchManyWithStats(['receta tarta'], { limit: 5 });
    expect(ok.no_answer).toBeUndefined();
    await put('project_b', 'Viajes', ['El viaje a Lisboa salió en marzo.']);
    process.env.CRBRO_NO_ANSWER = '0';
    const off = await engine.searchManyWithStats(['tarta de manzana del cumpleaños de la abuela viaje'], { limit: 5 });
    expect(off.no_answer).toBeUndefined();
    expect(off.results.length).toBe(2);
  });

  it('several phrasings: no_answer only when every phrasing found nothing clear', async () => {
    await put('project_a', 'Recetas', ['La receta de la tarta lleva tres huevos.']);
    const r = await engine.searchManyWithStats(['cumpleaños de la abuela en verano', 'receta tarta'], { limit: 5 });
    expect(r.no_answer).toBeUndefined();
  });
});

describe('B4 and idea 3: a big neuron does not win by size', () => {
  it('two hundred loosely related lines lose to the one line that answers', async () => {
    const notas = Array.from({ length: 200 }, (_, i) => `Nota ${i}: el cliente revisó la web y el servidor quedó pendiente.`);
    await put('project_notas', 'Notas', notas);
    await put('project_srv', 'Servidor', ['El servidor de la web del cliente tiene 16 GB de RAM.']);
    const hits = await engine.search('servidor web cliente RAM');
    expect(hits[0].neuron_id).toBe('project_srv');
  });
});

describe('B12: long entries are searched and returned by part', () => {
  const relleno = 'Durante la revisión se repasaron los pasos del procedimiento con el responsable. ';
  const largo = relleno.repeat(50) + 'El router de la oficina se reinicia solo los domingos a las cuatro.';

  it('cuts at boundaries, with overlap, as exact slices', () => {
    const parts = splitParts(largo);
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) expect(largo.slice(p.offset, p.offset + p.text.length)).toBe(p.text);
    expect(parts[parts.length - 1].offset + parts[parts.length - 1].text.length).toBe(largo.length);
    for (let i = 1; i < parts.length; i++) expect(parts[i].offset).toBeLessThan(parts[i - 1].offset + parts[i - 1].text.length);
    expect(splitParts('corto')).toEqual([{ offset: 0, text: 'corto' }]);
  });

  it('returns the part that matched, marked, with the entry id', async () => {
    await put('project_oficina', 'Oficina', [largo]);
    const [hit] = await engine.search('router oficina domingos');
    expect(hit.matching_content).toContain('domingos');
    expect(hit.matched_part).toBeDefined();
    expect(hit.matched_part!.parts).toBeGreaterThan(1);
    expect(hit.matched_part!.entry_chars).toBe(largo.length);
    expect(largo.slice(hit.matched_part!.offset).startsWith(hit.matching_content)).toBe(true);
    expect(hit.entry_id).toBe(factId(largo));
    // Parts of the same entry never fill also_matched.
    expect((hit.also_matched || []).filter(a => a.entry_id === hit.entry_id)).toEqual([]);
  });

  it('a revised long entry leaves recall with all its parts', async () => {
    await put('project_oficina', 'Oficina', [largo]);
    const nuevo = largo.replace('los domingos', 'los sábados');
    await put('project_oficina', 'Oficina', [nuevo]);
    const hits = await engine.search('router oficina domingos');
    expect(hits.every(h => !h.matching_content.includes('domingos'))).toBe(true);
    expect((await engine.search('router oficina sábados'))[0].matching_content).toContain('sábados');
  });

  it('a part whose entry was edited on disk is not served', async () => {
    await put('project_oficina', 'Oficina', [largo]);
    // Rewrite the file behind the index's back and check right away (no refresh window).
    const n = JSON.parse(await fs.readFile(brain.paths.neuron('project_oficina'), 'utf8'));
    n.facts[0].status = 'superseded';
    await fs.writeFile(brain.paths.neuron('project_oficina'), JSON.stringify(n));
    const hits = await engine.search('router oficina domingos');
    expect(hits.every(h => !h.matching_content.includes('domingos'))).toBe(true);
  });
});
