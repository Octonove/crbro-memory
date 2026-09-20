// ─── Folding what a bulk import left behind (2.5) ────────────────
//
// On the reference brain 766 of 1,200 neurons were born on one day: a
// transcript miner that made a neuron out of every checklist line. One line
// each, no tags, no links, 482 of them repeating a text another one has —
// and recall gives one result per neuron, so three identical lines took the
// top three places of an answer. compact folds each such burst into one
// digest neuron. These tests pin what it must never do: touch a neuron a
// person wrote, lose a line, or lose the only context a line had — its name.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

let holder: string;
let root: string;
let client: Client;
const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<any>;
const body = (r: any) => JSON.parse(r.content[0].text);
const cortexDir = () => path.join(root, 'cortex');
const ids = async () => (await fs.readdir(cortexDir())).map(f => f.replace(/\.json$/, '')).sort();

const OLD = '2026-05-13T10:00:00.000Z';

async function age(id: string, patch: Record<string, unknown> = {}) {
  const file = path.join(cortexDir(), `${id}.json`);
  const n = JSON.parse(await fs.readFile(file, 'utf8'));
  n.created = OLD;
  for (const f of n.facts) f.added = OLD;
  Object.assign(n, patch);
  await fs.writeFile(file, JSON.stringify(n, null, 2));
}

beforeAll(async () => {
  holder = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-compact-'));
  root = path.join(holder, 'brain');
  await fs.mkdir(root, { recursive: true });
  process.env.CRBRO_PATH = root;
  const { createServer } = await import('../src/server.js');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer().connect(st);
  client = new Client({ name: 'compact-test', version: '1.0.0' });
  await client.connect(ct);
  await call('crbro_boot');

  // The burst: 30 one-line neurons, ten of them repeating the same line.
  for (let i = 0; i < 30; i++) {
    const text = i < 10 ? '- x Navigate to https://ejemplo.test/portada' : `- x Verificar el bloque ${i} de la auditoría de Francortes`;
    const r = body(await call('crbro_learn', { topic: `Scratchpad auditoria paso ${i}`, type: 'fact', content: text }));
    await age(r.neuron_id);
  }
  // What a person wrote, and must survive untouched:
  const solo = body(await call('crbro_learn', { topic: 'Dato suelto antiguo', type: 'fact', content: 'El NIF de la gestoría se pide por correo.', domain: 'negocio' }));
  await age(solo.neuron_id);                                            // old, one line — but alone in its domain and day
  const tagged = body(await call('crbro_learn', { topic: 'Nota etiquetada', type: 'fact', content: 'Una línea con etiqueta.' }));
  await age(tagged.neuron_id, { tags: ['importante'] });                // same day and domain, but somebody tagged it
  const rica = body(await call('crbro_learn', { topic: 'Nota con dos líneas', type: 'fact', content: 'Primera línea.' }));
  await call('crbro_learn', { neuron_id: rica.neuron_id, type: 'pattern', content: 'Segunda, un patrón.' });
  await age(rica.neuron_id);                                            // two entries: a topic, not a leftover
  await call('crbro_learn', { topic: 'Nota de hoy', type: 'fact', content: 'Recién escrita, una sola línea.' });   // young
  await call('crbro_maintenance', {});                                  // reindex from the edited files
}, 180_000);

afterAll(async () => {
  await client?.close();
  delete process.env.CRBRO_PATH;
  await fs.rm(holder, { recursive: true, force: true });
});

describe('crbro_maintenance compact', () => {
  it('reports the burst and leaves everything where it is', async () => {
    const before = await ids();
    const r = body(await call('crbro_maintenance', { dry_run: true, compact: true }));
    expect(r.compactable_neurons).toBe(30);
    expect(r.compacted_neurons).toBe(0);
    expect(r.compact_groups).toHaveLength(1);
    expect(r.compact_groups[0]).toMatchObject({ day: '2026-05-13', domain: 'general', neurons: 30, unique_entries: 21, digest: 'Imported notes 2026-05-13 (general)' });
    expect(r.compact_groups[0].sample).toHaveLength(3);
    expect(r.compact_groups[0].ids).toBeUndefined();
    expect(r.notes.join(' ')).toMatch(/compact:true/);
    expect(await ids()).toEqual(before);
  });

  it('folds the burst into one digest and touches nothing a person wrote', async () => {
    const r = body(await call('crbro_maintenance', { compact: true }));
    expect(r.compacted_neurons).toBe(30);
    const now = await ids();
    expect(now.filter(i => i.startsWith('project_scratchpad_auditoria'))).toEqual([]);
    for (const kept of ['project_dato_suelto_antiguo', 'project_nota_etiquetada', 'project_nota_con_dos_lineas', 'project_nota_de_hoy']) {
      expect(now, kept).toContain(kept);
    }
    const digestId = now.find(i => i.includes('imported_notes'))!;
    const digest = JSON.parse(await fs.readFile(path.join(cortexDir(), `${digestId}.json`), 'utf8'));
    expect(digest.tags).toEqual(['digest']);
    expect(digest.facts).toHaveLength(21);                              // ten identical lines kept once
    expect(digest.facts.every((f: any) => f.added === OLD)).toBe(true); // dates travel
    expect(digest.created).toBe(OLD);
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
    expect(manifest.total_neurons).toBe(now.length);                    // the manifest followed
  });

  it('a line is still found, by its text and by the name its neuron had', async () => {
    const byText = body(await call('crbro_recall', { query: 'verificar bloque 17 auditoría Francortes' })).results[0];
    expect(byText.name).toBe('Imported notes 2026-05-13 (general)');
    expect(byText.matching_content).toContain('bloque 17');
    // "scratchpad" appears in no line: only in the names, which travelled as keys.
    const byName = body(await call('crbro_recall', { query: 'scratchpad paso' })).results[0];
    expect(byName.name).toBe('Imported notes 2026-05-13 (general)');
  });

  it('a digest earns no breadth: twenty matching lines of a pile do not outrank a neuron that is about it', async () => {
    const twin = body(await call('crbro_learn', { topic: 'Revisión del estudio', type: 'fact', content: '- x Verificar el bloque 11 de la auditoría de Francortes' }));
    await call('crbro_learn', { neuron_id: twin.neuron_id, type: 'fact', content: '- x Verificar el bloque 12 de la auditoría de Francortes' });
    await call('crbro_learn', { neuron_id: twin.neuron_id, type: 'fact', content: '- x Verificar el bloque 13 de la auditoría de Francortes' });
    process.env.CRBRO_RECENCY = '0';                                    // this is about breadth, not dates
    try {
      // No word of the old neuron names here: those travel as keys and would be a second match.
      const r = body(await call('crbro_recall', { query: 'verificar bloque francortes' }));
      expect(r.results.map((x: any) => x.name).slice(0, 2)).toEqual(['Revisión del estudio', 'Imported notes 2026-05-13 (general)']);
    } finally {
      delete process.env.CRBRO_RECENCY;
    }
  });

  it('every source has a quarantine copy, and restore brings one back', async () => {
    const copias = await fs.readdir(path.join(root, '.quarantine'));
    expect(copias.filter(f => f.startsWith('project_scratchpad_auditoria_paso_')).length).toBe(30);
    const r = body(await call('crbro_forget', { neuron: 'project_scratchpad_auditoria_paso_17', restore: true }));
    expect(r.neuron_id ?? r.restored ?? JSON.stringify(r)).toBeTruthy();
    expect(await ids()).toContain('project_scratchpad_auditoria_paso_17');
  });

  it('a second run finds nothing to fold, and the digest is not offered for splitting', async () => {
    const r = body(await call('crbro_maintenance', { compact: true }));
    expect(r.compactable_neurons).toBe(0);
    expect(r.compacted_neurons).toBe(0);
    expect(r.split_candidates.map((c: any) => c.name)).not.toContain('Imported notes 2026-05-13 (general)');
  });
});
