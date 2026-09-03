// ─── The 2.0 surface, as a client experiences it ─────────────────
//
// tool.definitions.test.ts checks that the 15 tools are declared correctly.
// This file checks what they DO: each crbro_inspect view returns the fields
// its description promises, the lifecycle tools (learn / revise / forget)
// behave as the three-stage rule says, crbro_connect can undo itself,
// crbro_context can be emptied, and a maintenance dry run touches nothing
// on disk. Everything speaks real MCP over an in-memory transport against a
// throwaway brain, so a regression in the server wiring shows up here even
// when the engine underneath is green.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

let root: string;
let client: Client;

const body = (r: any) => JSON.parse(r.content[0].text);
const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<any>;
const learn = async (topic: string, type: string, content: string, extra: Record<string, unknown> = {}) =>
  body(await call('crbro_learn', { topic, type, content, ...extra }));
const inspectNeuron = async (neuron: string, extra: Record<string, unknown> = {}) => {
  const r = await call('crbro_inspect', { view: 'neuron', neuron, ...extra });
  expect(r.isError, r.content?.[0]?.text).toBeFalsy();
  return r.structuredContent.neuron;
};

/** Every file under the brain root with its mtime and size — what a dry run must not change. */
async function snapshot(dir: string, base = dir): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(out, await snapshot(full, base));
    } else {
      const st = await fs.stat(full);
      out[path.relative(base, full)] = `${st.mtimeMs}:${st.size}`;
    }
  }
  return out;
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-surface2-'));
  // brain.ts reads the root when it loads: set the env BEFORE importing the
  // server, or the tests would run against the user's real brain.
  process.env.CRBRO_PATH = root;
  const { createServer } = await import('../src/server.js');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await createServer().connect(st);
  client = new Client({ name: 'surface2', version: '0.0.0' });
  await client.connect(ct);
  await call('crbro_boot');
}, 60_000);

afterAll(async () => {
  await client.close();
  delete process.env.CRBRO_PATH;
  await fs.rm(root, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════
describe('crbro_inspect', () => {
  it('view=status carries version, counters, the semantic block and hot_topics_recalculated', async () => {
    const r = await call('crbro_inspect', { view: 'status' });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent.status;
    expect(body(r)).toEqual(s);                       // text and structured say the same thing
    expect(s.crbro_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof s.brain_format).toBe('string');
    expect(typeof s.total_neurons).toBe('number');
    expect(typeof s.total_synapses).toBe('number');
    expect(typeof s.total_sessions).toBe('number');
    expect(s.brain_path).toBeTruthy();
    expect(s).toHaveProperty('last_boot');
    expect(s).toHaveProperty('last_consolidation');
    expect(s).toHaveProperty('hot_topics_recalculated');
    expect(typeof s.semantic.installed).toBe('boolean');
    expect(typeof s.semantic.enabled).toBe('boolean');
    expect(typeof s.semantic.mode).toBe('string');
    expect(typeof s.semantic.model_downloaded).toBe('boolean');
  });

  it('view=neuron pages facts newest first and hides superseded ones unless asked', async () => {
    const topic = 'Paginacion';
    const texts = [1, 2, 3, 4, 5].map(i => `Hecho de paginacion numero ${i} para la vista de neurona.`);
    let id = '';
    for (const t of texts) {
      id = (await learn(topic, 'fact', t)).neuron_id;
      await new Promise(r => setTimeout(r, 5));       // distinct `added` stamps
    }

    const page1 = await inspectNeuron(id, { limit: 2 });
    expect(page1.facts).toHaveLength(2);
    expect(page1.facts_pagination).toMatchObject({ total: 5, returned: 2, offset: 0, has_more: true, order: 'newest first', hidden_superseded: 0 });
    expect(page1.facts[0].added >= page1.facts[1].added).toBe(true);
    expect(page1.facts[0].text).toBe(texts[4]);

    const page3 = await inspectNeuron(id, { limit: 2, offset: 4 });
    expect(page3.facts).toHaveLength(1);
    expect(page3.facts_pagination).toMatchObject({ total: 5, returned: 1, offset: 4, has_more: false });
    expect(page3.facts[0].text).toBe(texts[0]);

    // Retire one: it leaves the default page and is counted as hidden.
    const rev = body(await call('crbro_revise', { neuron: id, facts: [texts[2]] }));
    expect(rev.revised_facts).toBe(1);
    const hidden = await inspectNeuron(id);
    expect(hidden.facts_pagination.total).toBe(4);
    expect(hidden.facts_pagination.hidden_superseded).toBe(1);
    expect(hidden.facts.map((f: any) => f.text)).not.toContain(texts[2]);

    const all = await inspectNeuron(id, { include_superseded: true });
    expect(all.facts_pagination.total).toBe(5);
    expect(all.facts.find((f: any) => f.text === texts[2]).status).toBe('superseded');
  });

  it('view=neuron resolves connections with name, type and strength, and honours min_strength', async () => {
    // Names must be far apart: findByName resolves near-misses ("Conexion A"
    // and "Conexion B" would land on the same neuron).
    const a = (await learn('Servidor Web', 'fact', 'El servidor web existe para probar conexiones resueltas.')).neuron_id;
    const b = (await learn('Base De Datos', 'fact', 'La base de datos existe para probar conexiones resueltas.')).neuron_id;
    expect(a).not.toBe(b);
    const made = body(await call('crbro_connect', { from: a, to: b, type: 'dependency', strength: 0.9, context: 'A depende de B' }));
    expect(made.action).toBe('created');

    const n = await inspectNeuron(a);
    expect(n.connection_ids).toEqual([b]);
    expect(n.total_connections).toBe(1);
    expect(n.connections[0]).toMatchObject({ target_id: b, target_name: 'Base De Datos', type: 'dependency', strength: 0.9, context: 'A depende de B' });

    const filtered = await inspectNeuron(a, { min_strength: 0.95 });
    expect(filtered.connections).toEqual([]);
    expect(filtered.total_connections).toBe(0);
    expect(filtered.connection_ids).toEqual([b]);   // the raw list is not filtered
  });

  it('view=neuron resolves by name too and bumps access_count on every read', async () => {
    const id = (await learn('Bump Access', 'fact', 'Leerme sube el contador de accesos.')).neuron_id;
    const first = await inspectNeuron(id);
    const second = await inspectNeuron('Bump Access');
    expect(second.id).toBe(id);
    expect(second.access_bumped).toBe(true);
    expect(second.access_count).toBe(first.access_count + 1);
    expect(second.last_accessed >= first.last_accessed).toBe(true);
  });

  it('view=neuron without `neuron` and with an unknown name answers with isError', async () => {
    const missing = await call('crbro_inspect', { view: 'neuron' });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toBeUndefined();
    const unknown = await call('crbro_inspect', { view: 'neuron', neuron: 'Nadie Se Llama Asi' });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain('Nadie Se Llama Asi');
  });

  it('view=neurons filters by domain and type, orders hottest first and pages with offset', async () => {
    await learn('Filtro Dom Uno', 'fact', 'Primera neurona del dominio filtrado.', { domain: 'dominio-filtro' });
    await learn('Filtro Dom Dos', 'fact', 'Segunda neurona del dominio filtrado.', { domain: 'dominio-filtro' });
    await learn('Filtro Otro', 'fact', 'Neurona de otro dominio.', { domain: 'otro-dominio' });

    const byDomain = await call('crbro_inspect', { view: 'neurons', domain: 'dominio-filtro' });
    expect(byDomain.isError).toBeFalsy();
    const rows = byDomain.structuredContent.neurons;
    expect(rows.total).toBe(2);
    expect(rows.offset).toBe(0);
    expect(rows.neurons.every((n: any) => n.domain === 'dominio-filtro')).toBe(true);
    for (const n of rows.neurons) {
      expect(typeof n.heat).toBe('number');
      expect(typeof n.facts_count).toBe('number');
      expect(n.last_accessed).toBeTruthy();
    }

    const all = (await call('crbro_inspect', { view: 'neurons', limit: 500 })).structuredContent.neurons;
    for (let i = 1; i < all.neurons.length; i++) {
      expect(all.neurons[i - 1].heat >= all.neurons[i].heat).toBe(true);
    }

    const byType = (await call('crbro_inspect', { view: 'neurons', type: 'project' })).structuredContent.neurons;
    expect(byType.neurons.every((n: any) => n.type === 'project')).toBe(true);
    const none = (await call('crbro_inspect', { view: 'neurons', type: 'person' })).structuredContent.neurons;
    expect(none.total).toBe(0);

    const p0 = (await call('crbro_inspect', { view: 'neurons', limit: 1, offset: 0 })).structuredContent.neurons;
    const p1 = (await call('crbro_inspect', { view: 'neurons', limit: 1, offset: 1 })).structuredContent.neurons;
    expect(p0.neurons).toHaveLength(1);
    expect(p1.neurons).toHaveLength(1);
    expect(p1.offset).toBe(1);
    expect(p0.neurons[0].id).toBe(all.neurons[0].id);
    expect(p1.neurons[0].id).toBe(all.neurons[1].id);
  });

  it('view=sessions lists the log a consolidate just wrote, newest first', async () => {
    const c = body(await call('crbro_consolidate', { summary: 'Sesion registrada para la vista sessions.' }));
    expect(c.session_logged).toBe(true);
    const r = await call('crbro_inspect', { view: 'sessions', limit: 5 });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent.sessions;
    expect(s.total).toBeGreaterThanOrEqual(1);
    expect(s.sessions[0].session_id).toBe(c.session_id);
    expect(s.sessions[0].summary).toContain('vista sessions');
    expect(Array.isArray(s.sessions[0].topics_touched)).toBe(true);
    expect(typeof s.sessions[0].key_facts_added).toBe('number');
    for (let i = 1; i < s.sessions.length; i++) {
      expect(s.sessions[i - 1].date >= s.sessions[i].date).toBe(true);
    }
    const one = (await call('crbro_inspect', { view: 'sessions', limit: 1 })).structuredContent.sessions;
    expect(one.sessions).toHaveLength(1);
  });

  it('consolidate topics_touched logs a neuron the session only read (what crbro_session_log did), drops unknown ids', async () => {
    // Written and consolidated once so the tally is empty afterwards: from
    // then on this neuron is one the session only *reads*.
    const id = (await learn('Solo Leida', 'fact', 'Neurona que esta sesion solo lee, nunca escribe.')).neuron_id;
    const prev = body(await call('crbro_consolidate', { summary: 'Cierre previo para vaciar el tally.' }));
    await call('crbro_forget', { session: prev.session_id });   // fresh day log

    const c = body(await call('crbro_consolidate', {
      summary: 'Sesion de solo lectura sobre la neurona.',
      topics_touched: [id, 'no_existe_tal_neurona', id],
    }));
    expect(c.session_logged).toBe(true);
    expect(c.facts_saved).toBe(0);                       // write counters stay real
    expect(c.topics_logged).toEqual([id]);               // deduplicated, unknown dropped
    expect(c.topics_unknown).toEqual(['no_existe_tal_neurona']);

    const s = (await call('crbro_inspect', { view: 'sessions', limit: 1 })).structuredContent.sessions;
    expect(s.sessions[0].session_id).toBe(c.session_id);
    expect(s.sessions[0].topics_touched).toContain(id);
    expect(s.sessions[0].topics_touched).not.toContain('no_existe_tal_neurona');
    expect(s.sessions[0].key_facts_added).toBe(0);
  });

  it('view=global_map computes clusters per domain and a bridge across domains, live, without a cache file', async () => {
    const a = (await learn('Faro Boreal', 'fact', 'Neurona del dominio norte.', { domain: 'norte' })).neuron_id;
    const b = (await learn('Pinguino Austral', 'fact', 'Neurona del dominio sur.', { domain: 'sur' })).neuron_id;
    expect(a).not.toBe(b);
    await call('crbro_connect', { from: a, to: b, strength: 0.7 });

    const r = await call('crbro_inspect', { view: 'global_map' });
    expect(r.isError).toBeFalsy();
    const g = r.structuredContent.global_map;
    expect(g.total_clusters).toBe(g.clusters.length);
    expect(g.total_bridges).toBe(g.bridges.length);
    expect(g.clusters.map((c: any) => c.name)).toEqual(expect.arrayContaining(['norte', 'sur']));
    expect(g.clusters.find((c: any) => c.name === 'norte').nodes).toContain(a);
    const bridge = g.bridges.find((x: any) =>
      (x.from === 'norte' && x.to === 'sur') || (x.from === 'sur' && x.to === 'norte'));
    expect(bridge).toBeTruthy();
    expect(bridge.via.length).toBeGreaterThan(0);
    expect(new Date(g.computed_at).toString()).not.toBe('Invalid Date');
    await expect(fs.access(path.join(root, 'prefrontal', 'global_map.json'))).rejects.toThrow();

    // Live: a new domain shows up on the very next call.
    await learn('Amanecer Oriental', 'fact', 'Neurona del dominio este.', { domain: 'este' });
    const again = (await call('crbro_inspect', { view: 'global_map' })).structuredContent.global_map;
    expect(again.clusters.map((c: any) => c.name)).toContain('este');
    expect(again.total_clusters).toBe(g.total_clusters + 1);
  });

  it('ignores parameters that belong to another view', async () => {
    const r = await call('crbro_inspect', { view: 'status', neuron: 'whatever', domain: 'x', limit: 3, offset: 9 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.view).toBe('status');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('crbro_connect', () => {
  it('sets an absolute strength on create and on strengthen, and falls back to +0.1 without one', async () => {
    const a = (await learn('Motor Cohete', 'fact', 'Neurona del motor para probar la fuerza absoluta.')).neuron_id;
    const b = (await learn('Deposito Combustible', 'fact', 'Neurona del deposito para probar la fuerza absoluta.')).neuron_id;
    expect(a).not.toBe(b);

    const made = body(await call('crbro_connect', { from: a, to: b, strength: 0.3 }));
    expect(made.action).toBe('created');
    expect(made.strength).toBe(0.3);
    expect(made.synapse_id).toBeTruthy();

    const set = body(await call('crbro_connect', { from: a, to: b, strength: 0.95 }));
    expect(set.action).toBe('strengthened');
    expect(set.strength).toBe(0.95);
    expect(set.synapse_id).toBe(made.synapse_id);

    const plus = body(await call('crbro_connect', { from: b, to: a }));    // order is irrelevant
    expect(plus.action).toBe('strengthened');
    expect(plus.strength).toBe(1);                                          // min(1, 0.95 + 0.1)
    expect(plus.synapse_id).toBe(made.synapse_id);

    const seen = await inspectNeuron(a);
    expect(seen.connections[0]).toMatchObject({ target_id: b, strength: 1, type: 'conceptual' });
  });

  it('disconnect removes the synapse and unlinks both neurons; a repeat is absent, not an error', async () => {
    const a = (await learn('Tijeras Afiladas', 'fact', 'Neurona de las tijeras para probar la desconexion.')).neuron_id;
    const b = (await learn('Cuerda Gruesa', 'fact', 'Neurona de la cuerda para probar la desconexion.')).neuron_id;
    expect(a).not.toBe(b);
    await call('crbro_connect', { from: a, to: b });
    expect((await inspectNeuron(b)).connection_ids).toEqual([a]);

    const cut = await call('crbro_connect', { action: 'disconnect', from: a, to: b });
    expect(cut.isError).toBeFalsy();
    expect(body(cut)).toMatchObject({ action: 'disconnected', removed: true });

    expect((await inspectNeuron(a)).connection_ids).toEqual([]);
    expect((await inspectNeuron(b)).connection_ids).toEqual([]);
    expect((await inspectNeuron(a)).total_connections).toBe(0);

    const again = body(await call('crbro_connect', { action: 'disconnect', from: a, to: b }));
    expect(again).toMatchObject({ action: 'absent', removed: false });
  });

  it('validates both ids for connect and disconnect alike', async () => {
    const a = (await learn('Valida A', 'fact', 'Neurona A para validar ids.')).neuron_id;
    const c1 = await call('crbro_connect', { from: 'no_such_neuron', to: a });
    expect(c1.isError).toBe(true);
    expect(c1.content[0].text).toContain('no_such_neuron');
    const c2 = await call('crbro_connect', { action: 'disconnect', from: a, to: 'no_such_neuron' });
    expect(c2.isError).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('crbro_revise', () => {
  it('edits summary, domain, tags and name in one call; the id never moves; a no-op changes nothing', async () => {
    const id = (await learn('Metadatos Neurona', 'fact', 'Neurona cuyos metadatos se editan.', { domain: 'general' })).neuron_id;

    const r = body(await call('crbro_revise', {
      neuron: id, summary: 'Resumen nuevo.', domain: 'dominio-nuevo', tags: ['uno', ' dos ', 'uno', ''], name: 'Nombre Nuevo',
    }));
    expect(r.neuron_id).toBe(id);
    expect(r.revised_facts).toBe(0);
    expect(r.revised_entries).toBe(0);
    expect([...r.changed].sort()).toEqual(['domain', 'name', 'summary', 'tags']);
    expect(r.message).toContain('updated');

    const n = await inspectNeuron(id);
    expect(n.id).toBe(id);
    expect(n.summary).toBe('Resumen nuevo.');
    expect(n.domain).toBe('dominio-nuevo');
    expect(n.tags).toEqual(['uno', 'dos']);          // trimmed, deduplicated, empties dropped
    expect(n.name).toBe('Nombre Nuevo');

    // The file still lives under the old id, and the id keeps resolving.
    // (Name resolution keys on the id slug, so the NEW display name is not a
    // lookup key — documented in the .describe(), asserted nowhere here.)
    expect((await inspectNeuron(id)).name).toBe('Nombre Nuevo');
    await expect(fs.access(path.join(root, 'cortex', `${id}.json`))).resolves.toBeUndefined();

    const same = body(await call('crbro_revise', { neuron: id, summary: 'Resumen nuevo.', tags: ['uno', 'dos'] }));
    expect(same.changed).toEqual([]);
    expect(same.message).toContain('Nothing changed');

    // tags replaces the whole list.
    const replaced = body(await call('crbro_revise', { neuron: id, tags: ['tres'] }));
    expect(replaced.changed).toEqual(['tags']);
    expect((await inspectNeuron(id)).tags).toEqual(['tres']);
  });

  it('redacts a credential written into the summary and reports the kind, never the value', async () => {
    const id = (await learn('Resumen Secreto', 'fact', 'Neurona con resumen que trae un token.')).neuron_id;
    const token = 'ghp_' + 'A'.repeat(36);
    const r = body(await call('crbro_revise', { neuron: id, summary: `El deploy usa el token ${token} de GitHub.` }));
    expect(r.changed).toEqual(['summary']);
    expect(r.redacted).toContain('GitHub token');
    const n = await inspectNeuron(id);
    expect(n.summary).not.toContain(token);
    expect(n.summary).toContain('GitHub');
  });

  it('retires and reactivates decisions, patterns, errors and debts by exact text through entry_status', async () => {
    const topic = 'Entradas Retirables';
    const pattern = 'Validar siempre la entrada del usuario en el servidor.';
    const error = 'ERROR: olvidamos el indice en la tabla mensajes. FIX: crear indice compuesto.';
    const debt = 'DEFERRED: paginacion del historial. CEILING: 500 filas. REVISIT WHEN: haya mas de 400 usuarios.';
    const decision = 'Decidimos usar colas para el envio de correos.';
    const id = (await learn(topic, 'pattern', pattern)).neuron_id;
    await learn(topic, 'error', error);
    await learn(topic, 'debt', debt);
    await learn(topic, 'decision', decision);

    const recallHas = async (query: string, needle: string) => {
      const r = await call('crbro_recall', { query });
      return r.structuredContent.results.map((x: any) => x.matching_content).join('\n').includes(needle);
    };
    expect(await recallHas('validar entrada usuario servidor', 'Validar siempre')).toBe(true);

    const retired = body(await call('crbro_revise', {
      neuron: id, entries: [pattern, error, debt, decision, 'texto que no existe'], status: 'retracted', note: 'never true',
    }));
    expect(retired.revised_entries).toBe(4);
    expect(retired.status).toBe('retracted');
    expect(retired.unmatched).toEqual(['texto que no existe']);
    expect(retired.message).toContain('no longer appear in recall');

    const n = await inspectNeuron(id);
    expect(Object.keys(n.entry_status)).toHaveLength(4);
    for (const st of Object.values(n.entry_status) as any[]) {
      expect(st.status).toBe('retracted');
      expect(st.note).toBe('never true');
      expect(st.revised).toBeTruthy();
    }
    // The entries themselves stay in the file...
    expect(n.patterns).toContain(pattern);
    expect(n.errors).toContain(error);
    expect(n.debts).toContain(debt);
    expect(n.decisions.map((d: any) => d.text)).toContain(decision);
    // ...but leave recall.
    expect(await recallHas('validar entrada usuario servidor', 'Validar siempre')).toBe(false);

    // Retiring the same line twice matches nothing.
    const twice = body(await call('crbro_revise', { neuron: id, entries: [pattern] }));
    expect(twice.revised_entries).toBe(0);
    expect(twice.unmatched).toEqual([pattern]);

    // Reactivation: the sidecar key goes, the chunk is back in recall.
    const back = body(await call('crbro_revise', { neuron: id, entries: [pattern, debt], status: 'active' }));
    expect(back.revised_entries).toBe(2);
    expect(back.status).toBe('active');
    expect(back.shared_warning).toBeUndefined();     // not a shared neuron
    const after = await inspectNeuron(id);
    expect(Object.keys(after.entry_status)).toHaveLength(2);
    expect(await recallHas('validar entrada usuario servidor', 'Validar siempre')).toBe(true);

    // Only retired entries match status active.
    const noop = body(await call('crbro_revise', { neuron: id, entries: [pattern], status: 'active' }));
    expect(noop.revised_entries).toBe(0);
  });

  it('reports unmatched facts and an unknown neuron plainly', async () => {
    const id = (await learn('Sin Coincidencia', 'fact', 'Un hecho cualquiera para probar unmatched.')).neuron_id;
    const r = body(await call('crbro_revise', { neuron: id, facts: ['esto no es un hecho guardado'] }));
    expect(r.revised_facts).toBe(0);
    expect(r.unmatched).toEqual(['esto no es un hecho guardado']);
    expect(r.message).toContain('Nothing matched');

    const missing = await call('crbro_revise', { neuron: 'no_such_neuron', facts: ['x'] });
    expect(missing.content[0].text).toContain('Neuron not found: "no_such_neuron"');
    expect(missing.structuredContent).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('crbro_learn', () => {
  it('merges keywords on a duplicate, replaces them with keywords_replace, updates confidence in place', async () => {
    const topic = 'Palabras Clave';
    const text = 'El servicio de correo transaccional es Resend.';
    const first = await learn(topic, 'fact', text, { keywords: ['Alpha', 'beta'] });
    expect(first.action).toBe('created');
    const id = first.neuron_id;
    const fact = async () => (await inspectNeuron(id)).facts.find((f: any) => f.text === text);
    expect((await fact()).keys).toEqual(['alpha', 'beta']);

    const merged = await learn(topic, 'fact', text, { keywords: ['gamma'] });
    expect(merged.neuron_id).toBe(id);
    expect(merged.duplicate).toBe(true);
    expect(merged.updated_in_place).toBe(true);
    expect(merged.superseded_facts).toBe(0);
    expect(merged.total_facts).toBe(1);
    expect((await fact()).keys).toEqual(['alpha', 'beta', 'gamma']);
    expect((await inspectNeuron(id)).facts_pagination.total).toBe(1);   // still one fact

    const replaced = await learn(topic, 'fact', text, { keywords: ['delta'], keywords_replace: true });
    expect(replaced.duplicate).toBe(true);
    expect(replaced.updated_in_place).toBe(true);
    expect((await fact()).keys).toEqual(['delta']);

    const conf = await learn(topic, 'fact', text.toUpperCase(), { confidence: 0.4 });   // case-insensitive match
    expect(conf.duplicate).toBe(true);
    expect(conf.updated_in_place).toBe(true);
    expect((await fact()).confidence).toBe(0.4);
    expect((await fact()).text).toBe(text);                                             // the stored telling stays

    const nothing = await learn(topic, 'fact', text, { keywords: ['delta'], confidence: 0.4 });
    expect(nothing.duplicate).toBe(true);
    expect(nothing.updated_in_place).toBeUndefined();
    expect(nothing.total_facts).toBe(1);

    // keywords_replace with an empty list drops the field altogether.
    const cleared = await learn(topic, 'fact', text, { keywords: [], keywords_replace: true });
    expect(cleared.updated_in_place).toBe(true);
    expect((await fact()).keys).toBeUndefined();
  });

  it('refuses to re-learn a retired fact or entry with skipped_retired and points at revise status active', async () => {
    const topic = 'Retirado';
    const text = 'El bucket de backups se llama octonove-backups-eu.';
    const id = (await learn(topic, 'fact', text)).neuron_id;
    const rev = body(await call('crbro_revise', { neuron: id, facts: [text], note: 'bucket renamed' }));
    expect(rev.revised_facts).toBe(1);

    const again = await learn(topic, 'fact', text);
    expect(again.action).toBe('skipped_retired');
    expect(again.neuron_id).toBe(id);
    expect(again.skipped_retired.status).toBe('superseded');
    expect(again.skipped_retired.note).toBe('bucket renamed');
    expect(again.skipped_retired.id).toBeTruthy();
    expect(again.skipped_retired.revised).toBeTruthy();
    expect(again.message).toContain('crbro_revise status active');
    expect((await inspectNeuron(id, { include_superseded: true })).facts_pagination.total).toBe(1);

    // Same for a pattern retired through entries.
    const pattern = 'Los despliegues se hacen los martes por la manana.';
    await learn(topic, 'pattern', pattern);
    await call('crbro_revise', { neuron: id, entries: [pattern], status: 'retracted' });
    const p = await learn(topic, 'pattern', pattern);
    expect(p.action).toBe('skipped_retired');
    expect(p.skipped_retired.status).toBe('retracted');
    expect((await inspectNeuron(id)).patterns).toEqual([pattern]);

    // Reactivate, and learning it again is an ordinary duplicate.
    await call('crbro_revise', { neuron: id, facts: [text], status: 'active' });
    const alive = await learn(topic, 'fact', text);
    expect(alive.action).not.toBe('skipped_retired');
    expect(alive.duplicate).toBe(true);
    expect(alive.total_facts).toBe(1);
  });

  it('supersedes in one call: the old telling leaves the default view and recall', async () => {
    const topic = 'Sustitucion';
    const old = 'La API escucha en el puerto 3000.';
    const id = (await learn(topic, 'fact', old)).neuron_id;
    const r = await learn(topic, 'fact', 'La API escucha en el puerto 8080.', { supersedes: [old] });
    expect(r.superseded_facts).toBe(1);
    expect(r.supersedes_unmatched).toBeUndefined();
    const n = await inspectNeuron(id);
    expect(n.facts.map((f: any) => f.text)).toEqual(['La API escucha en el puerto 8080.']);
    expect(n.facts_pagination.hidden_superseded).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('crbro_forget', () => {
  it('entire: the token goes stale when the neuron changes, and the delete removes its synapses too', async () => {
    const topic = 'Borrado Completo';
    const id = (await learn(topic, 'fact', 'Primer hecho de la neurona a borrar.')).neuron_id;
    const other = (await learn('Vecina Del Borrado', 'fact', 'Neurona vecina que sobrevive al borrado.')).neuron_id;
    await call('crbro_connect', { from: id, to: other });

    const dry1 = body(await call('crbro_forget', { neuron: id, entire: true }));
    expect(dry1.dry_run).toBe(true);
    expect(dry1.shared_in).toBeNull();
    expect(dry1.counts).toMatchObject({ facts: 1, connections: 1 });
    expect(dry1.confirm_token).toMatch(/^[a-f0-9]{8}$/);

    // A write in between invalidates the token.
    await learn(topic, 'fact', 'Segundo hecho, anadido despues del dry run.');
    const stale = await call('crbro_forget', { neuron: id, entire: true, confirm_token: dry1.confirm_token });
    expect(stale.isError).toBe(true);
    expect(stale.content[0].text).toContain('Stale');
    expect((await inspectNeuron(id)).facts_pagination.total).toBe(2);   // nothing deleted

    const dry2 = body(await call('crbro_forget', { neuron: id, entire: true }));
    expect(dry2.confirm_token).not.toBe(dry1.confirm_token);
    expect(dry2.counts.facts).toBe(2);

    // The neuron can be named by name for the real call too.
    const done = body(await call('crbro_forget', { neuron: topic, entire: true, confirm_token: dry2.confirm_token }));
    expect(done).toMatchObject({ neuron_id: id, removed: 'neuron', synapses_removed: 1 });
    expect(done.counts.facts).toBe(2);
    expect(done.backup).toContain(id);
    await expect(fs.access(done.backup)).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, 'cortex', `${id}.json`))).rejects.toThrow();

    // The neighbour no longer points at a ghost, and recall does not find it.
    expect((await inspectNeuron(other)).connection_ids).toEqual([]);
    const recall = await call('crbro_recall', { query: 'primer hecho neurona borrar' });
    expect(recall.structuredContent.results.map((x: any) => x.neuron_id)).not.toContain(id);
    // Status counters follow.
    const status = (await call('crbro_inspect', { view: 'status' })).structuredContent.status;
    const rows = (await call('crbro_inspect', { view: 'neurons', limit: 500 })).structuredContent.neurons;
    expect(status.total_neurons).toBe(rows.total);
  });

  it('restore merges the quarantine copy into a neuron that exists again', async () => {
    const topic = 'Restaurable';
    const id = (await learn(topic, 'fact', 'Hecho uno de la neurona restaurable.')).neuron_id;
    await learn(topic, 'fact', 'Hecho dos de la neurona restaurable.');
    await learn(topic, 'decision', 'Decision guardada antes del borrado.');
    const dry = body(await call('crbro_forget', { neuron: id, entire: true }));
    await call('crbro_forget', { neuron: id, entire: true, confirm_token: dry.confirm_token });

    // The topic comes back with one fresh fact, then the copy is restored on top.
    expect((await learn(topic, 'fact', 'Hecho tres, escrito tras el borrado.')).action).toBe('created');
    const r = body(await call('crbro_forget', { neuron: id, restore: true }));
    expect(r.neuron_id).toBe(id);
    expect(r.merged_into_existing).toBe(true);
    expect(r.restored_from).toContain('.quarantine');
    expect(r.moved).toMatchObject({ facts: 2, decisions: 1 });
    expect(r.message).toContain('merged');

    const n = await inspectNeuron(id);
    expect(n.facts_pagination.total).toBe(3);
    expect(n.decisions).toHaveLength(1);

    // Restore is repeatable and idempotent: nothing moves the second time.
    const again = body(await call('crbro_forget', { neuron: id, restore: true }));
    expect(again.merged_into_existing).toBe(true);
    expect(again.moved).toMatchObject({ facts: 0, decisions: 0 });

    const none = await call('crbro_forget', { neuron: 'never_quarantined_neuron', restore: true });
    expect(none.content[0].text).toContain('No quarantine copy');
  });

  it('merge_into moves facts and decisions, rewires synapses and deletes the source', async () => {
    const a = (await learn('Fusion Origen', 'fact', 'Hecho A1 que viaja con la fusion.')).neuron_id;
    await learn('Fusion Origen', 'fact', 'Hecho A2 que viaja con la fusion.');
    await learn('Fusion Origen', 'decision', 'Decision tomada en el origen de la fusion.');
    await learn('Fusion Origen', 'pattern', 'Patron del origen de la fusion.');
    const b = (await learn('Fusion Destino', 'fact', 'Hecho B1 que ya estaba en el destino.')).neuron_id;
    await learn('Fusion Destino', 'fact', 'Hecho A2 que viaja con la fusion.');         // shared telling: not moved twice
    const c = (await learn('Fusion Tercero', 'fact', 'Tercera neurona conectada al origen.')).neuron_id;
    const d = (await learn('Fusion Cuarto', 'fact', 'Cuarta neurona conectada a origen y destino.')).neuron_id;
    expect(new Set([a, b, c, d]).size).toBe(4);
    await call('crbro_connect', { from: a, to: c, strength: 0.4 });      // moved
    await call('crbro_connect', { from: a, to: d, strength: 0.9 });      // merged with b↔d
    await call('crbro_connect', { from: b, to: d, strength: 0.2 });
    await call('crbro_connect', { from: a, to: b, strength: 0.5 });      // dropped (would be a self loop)

    const r = body(await call('crbro_forget', { neuron: a, merge_into: 'Fusion Destino' }));
    expect(r.from).toBe(a);
    expect(r.into).toBe(b);
    expect(r.backup).toContain(a);
    expect(r.moved).toMatchObject({ facts: 1, decisions: 1, patterns: 1 });
    expect(r.synapses).toEqual({ moved: 1, merged: 1, dropped: 1 });

    const into = await inspectNeuron(b);
    expect(into.facts_pagination.total).toBe(3);
    expect(into.decisions.map((x: any) => x.text)).toContain('Decision tomada en el origen de la fusion.');
    expect(into.patterns).toContain('Patron del origen de la fusion.');
    expect([...into.connection_ids].sort()).toEqual([c, d].sort());
    const toD = into.connections.find((x: any) => x.target_id === d);
    expect(toD.strength).toBe(0.9);                                        // max of the two
    expect((await inspectNeuron(c)).connection_ids).toEqual([b]);
    expect((await inspectNeuron(d)).connection_ids).toEqual([b]);

    const gone = await call('crbro_inspect', { view: 'neuron', neuron: a });
    expect(gone.isError).toBe(true);

    // Same neuron on both sides is refused politely.
    const same = await call('crbro_forget', { neuron: b, merge_into: 'Fusion Destino' });
    expect(same.content[0].text).toContain('same neuron');
    expect((await inspectNeuron(b)).facts_pagination.total).toBe(3);

    // Undo: the source comes back from quarantine as its own neuron.
    const back = body(await call('crbro_forget', { neuron: a, restore: true }));
    expect(back.merged_into_existing).toBe(false);
    expect((await inspectNeuron(a)).facts_pagination.total).toBe(2);
  });

  it('facts mode deletes a decision by exact text and prunes its entry_status', async () => {
    const topic = 'Borrado Parcial';
    const decision = 'Decidimos borrar esta decision por completo.';
    const id = (await learn(topic, 'fact', 'Hecho que se queda.')).neuron_id;
    await learn(topic, 'decision', decision);
    await call('crbro_revise', { neuron: id, entries: [decision] });
    expect(Object.keys((await inspectNeuron(id)).entry_status)).toHaveLength(1);

    const r = body(await call('crbro_forget', { neuron: id, facts: [decision] }));
    expect(r.removed).toBe(1);
    expect(r.backup).toBeTruthy();
    const n = await inspectNeuron(id);
    expect(n.decisions).toEqual([]);
    expect(n.entry_status).toBeUndefined();
    expect(n.facts_pagination.total).toBe(1);
  });

  it('session mode quarantines and deletes one day log; a repeat says removed:false', async () => {
    const c = body(await call('crbro_consolidate', { summary: 'Sesion que sera olvidada.' }));
    const before = (await call('crbro_inspect', { view: 'status' })).structuredContent.status.total_sessions;
    const r = body(await call('crbro_forget', { session: c.session_id.replace(/^session_/, '') }));
    expect(r).toMatchObject({ session_id: c.session_id, removed: true });
    expect(r.backup).toContain('.quarantine');
    await expect(fs.access(r.backup)).resolves.toBeUndefined();

    const sessions = (await call('crbro_inspect', { view: 'sessions' })).structuredContent.sessions;
    expect(sessions.sessions.map((s: any) => s.session_id)).not.toContain(c.session_id);
    const after = (await call('crbro_inspect', { view: 'status' })).structuredContent.status.total_sessions;
    expect(after).toBe(before - 1);

    const again = body(await call('crbro_forget', { session: c.session_id }));
    expect(again.removed).toBe(false);
    expect(again.backup).toBeNull();
  });

  it('refuses no mode, confirm_token without entire, and a neuron-less mode', async () => {
    expect((await call('crbro_forget', { neuron: 'x' })).isError).toBe(true);
    expect((await call('crbro_forget', { neuron: 'x', restore: true, confirm_token: 'abc' })).isError).toBe(true);
    expect((await call('crbro_forget', { facts: ['x'] })).isError).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('crbro_context', () => {
  it('discard_pending drops without recording, resolve_pending records, clear empties everything', async () => {
    await call('crbro_context', { clear: true });
    await call('crbro_context', { set_topics: ['project_uno', 'project_dos'], add_pending: 'Renovar el certificado del dominio principal' });
    const added = body(await call('crbro_context', { add_pending: 'Revisar las alertas de disco del VPS' }));
    expect(added.written).toBe(true);
    expect(added.active_topics).toEqual(['project_uno', 'project_dos']);
    expect(added.pending_tasks).toHaveLength(2);

    const resolved = body(await call('crbro_context', { resolve_pending: 'certificado del dominio' }));
    expect(resolved.resolved).toHaveLength(1);
    expect(resolved.recently_closed).toHaveLength(1);
    expect(resolved.pending_tasks).toHaveLength(1);

    const discarded = body(await call('crbro_context', { discard_pending: 'alertas de disco' }));
    expect(discarded.written).toBe(true);
    expect(discarded.discarded).toHaveLength(1);
    expect(discarded.discarded[0].text).toBe('Revisar las alertas de disco del VPS');
    expect(discarded.pending_tasks).toEqual([]);
    expect(discarded.recently_closed).toHaveLength(1);           // untouched by the discard
    expect(JSON.stringify(discarded.recently_closed)).not.toContain('alertas de disco');

    const read = body(await call('crbro_context'));
    expect(read.written).toBe(false);
    expect(read.resolved).toEqual([]);
    expect(read.discarded).toEqual([]);
    expect(read.recently_closed).toHaveLength(1);

    await call('crbro_context', { add_pending: 'Algo que el clear se lleva' });
    const cleared = body(await call('crbro_context', { clear: true }));
    expect(cleared.written).toBe(true);
    expect(cleared.active_topics).toEqual([]);
    expect(cleared.pending_tasks).toEqual([]);
    expect(cleared.recently_closed).toEqual([]);

    // clear runs before the other updates in the same call.
    const both = body(await call('crbro_context', { clear: true, add_pending: 'Sobrevive al clear de la misma llamada' }));
    expect(both.pending_tasks).toHaveLength(1);
    expect(both.pending_tasks[0].text).toBe('Sobrevive al clear de la misma llamada');
    await call('crbro_context', { clear: true });
  });

  it('a read with no arguments does not rewrite the context file', async () => {
    const file = path.join(root, 'prefrontal', 'active_context.json');
    const before = await fs.stat(file);
    await new Promise(r => setTimeout(r, 20));
    const r = body(await call('crbro_context'));
    expect(r.written).toBe(false);
    const after = await fs.stat(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('crbro_maintenance', () => {
  it('dry_run changes not one file under the brain root', async () => {
    // Settle everything that legitimately writes: a real run, then a
    // consolidate (flushes the index and clears its debounce timer).
    await call('crbro_maintenance', {});
    await call('crbro_consolidate', { summary: 'Asentar el cerebro antes del dry run.' });
    await new Promise(r => setTimeout(r, 30));

    const before = await snapshot(root);
    expect(Object.keys(before).length).toBeGreaterThan(5);
    const r = await call('crbro_maintenance', { dry_run: true, archive: true, repair: true, unarchive: 'all', purge_boilerplate: true });
    expect(r.isError).toBeFalsy();
    const report = body(r);
    const after = await snapshot(root);

    expect(after).toEqual(before);
    expect(report.mode).toBe('DRY RUN');
    expect(report.heat_recalculated).toBe(false);
    expect(report.index_rebuilt).toBe(false);
    expect(report.archived_neurons).toBe(0);
    expect(report.unarchived_neurons).toBe(0);
    expect(report.repaired).toBe(0);
    expect(report.repairs).toEqual([]);
    expect(typeof report.repairable).toBe('number');
    expect(typeof report.archives_count).toBe('number');
    expect(typeof report.clusters_detected).toBe('number');
    expect(report.notes.join(' ')).toContain('Dry run');
    await expect(fs.access(path.join(root, 'prefrontal', 'global_map.json'))).rejects.toThrow();
  }, 60_000);

  it('repair fixes a dangling connection the integrity check reported', async () => {
    const id = (await learn('Reparable', 'fact', 'Neurona con una conexion colgante inyectada.')).neuron_id;
    const file = path.join(root, 'cortex', `${id}.json`);
    const raw = JSON.parse(await fs.readFile(file, 'utf-8'));
    raw.connections = ['project_fantasma_que_no_existe'];
    await fs.writeFile(file, JSON.stringify(raw), 'utf-8');

    const dry = body(await call('crbro_maintenance', { dry_run: true }));
    expect(dry.integrity_issues.join('\n')).toContain('project_fantasma_que_no_existe');
    expect(dry.repairable).toBeGreaterThanOrEqual(1);
    expect(dry.repaired).toBe(0);

    const fixed = body(await call('crbro_maintenance', { repair: true }));
    expect(fixed.mode).toBe('EXECUTED');
    expect(fixed.repaired).toBeGreaterThanOrEqual(1);
    expect(fixed.repairs.join('\n')).toContain(`${id} → project_fantasma_que_no_existe`);
    expect(fixed.integrity_issues.join('\n')).not.toContain('project_fantasma_que_no_existe');
    expect((await inspectNeuron(id)).connection_ids).toEqual([]);

    const clean = body(await call('crbro_maintenance', { dry_run: true }));
    expect(clean.repairable).toBe(0);
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════
describe('crbro_boot', () => {
  it('serves the full retired_tools map and the last three sessions, last_session first', async () => {
    const expected: Record<string, string> = {
      crbro_status: 'crbro_inspect view=status',
      crbro_neuron: 'crbro_inspect view=neuron neuron=<id or name>',
      crbro_neurons: 'crbro_inspect view=neurons [domain|type|min_heat|limit|offset]',
      crbro_hot_topics: 'crbro_inspect view=neurons (rows) and crbro_inspect view=status (hot_topics_recalculated)',
      crbro_connections: 'crbro_inspect view=neuron neuron=<id> [min_strength]',
      crbro_sessions: 'crbro_inspect view=sessions [limit]',
      crbro_global_map: 'crbro_inspect view=global_map',
      crbro_session_log: 'crbro_consolidate summary=... [topics_touched=[...] for neuron ids you only read] (logs the session) plus crbro_context set_topics=[...] if you need to replace the active topics',
      crbro_sync: 'crbro_space action=sync [name]',
    };
    const c = body(await call('crbro_consolidate', { summary: 'Sesion para comprobar recent_sessions en boot.' }));
    const b = body(await call('crbro_boot'));
    expect(b.retired_tools).toEqual(expected);
    expect(Array.isArray(b.recent_sessions)).toBe(true);
    expect(b.recent_sessions.length).toBeGreaterThanOrEqual(1);
    expect(b.recent_sessions.length).toBeLessThanOrEqual(3);
    expect(b.recent_sessions[0].session_id).toBe(c.session_id);
    expect(b.recent_sessions[0].summary).toContain('recent_sessions en boot');
    expect(b.last_session).toBe(c.session_id);
    expect(b.memory_discipline).toContain('crbro_inspect');
    expect(b.memory_discipline).toContain('crbro_forget');
    for (const old of Object.keys(expected)) expect(b.memory_discipline).not.toContain(old);
  });

  it('exports RETIRED_TOOLS from the server module with the same content boot serves', async () => {
    const mod: any = await import('../src/server.js');
    const b = body(await call('crbro_boot'));
    expect(mod.RETIRED_TOOLS).toEqual(b.retired_tools);
    expect(Object.isFrozen(mod.RETIRED_TOOLS) || typeof mod.RETIRED_TOOLS === 'object').toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('crbro_space and crbro_share outside any space', () => {
  it('leave of an unknown space and unshare of an unshared neuron fail softly', async () => {
    const leave = await call('crbro_space', { action: 'leave', name: 'espacio-inexistente' });
    expect(leave.isError).toBeFalsy();
    const l = body(leave);
    expect(l.ok).toBe(false);
    expect(l.message).toContain('espacio-inexistente');
    expect(l.next).toBeUndefined();

    const id = (await learn('No Compartida', 'fact', 'Neurona que nunca se compartio.')).neuron_id;
    const un = body(await call('crbro_share', { neuron: id, unshare: true }));
    expect(un.ok).toBe(false);
    expect(un.neuron_id).toBe(id);
    expect(un.space).toBeNull();
    expect(un.message).toContain('not shared');

    const noName = await call('crbro_space', { action: 'leave' });
    expect(noName.content[0].text).toContain('name is required');
  });
});
