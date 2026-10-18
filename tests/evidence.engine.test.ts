import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Brain } from '../src/engine/brain.js';
import { Cortex, unionNeuron } from '../src/engine/cortex.js';
import { shelfOfFact, factStaleness, DEFAULT_SHELF_DAYS } from '../src/engine/shelf.js';
import { entryId, encodeOp, decodeOps, type Op } from '../src/sync/ops.js';
import { applyOps } from '../src/sync/materialize.js';
import { attachSync, commitShare, getIdentity, markShared, prepareShare, spaceDir } from '../src/sync/space.js';
import { writeJSON } from '../src/utils/fs.js';
import { describeEvidence } from '../src/engine/evidence.js';

let root: string, brain: Brain, cortex: Cortex;
const text = 'El panel usa el puerto 8443.';
const pattern = 'Comprobar el panel cada lunes.';
const reference = { kind: 'file', value: 'config/panel.json', field: 'port', project: 'panel' } as const;
const at = '2026-10-16T12:00:00.000Z';
const earlier = '2026-10-15T12:00:00.000Z';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-evidence-'));
  brain = new Brain(root);
  await brain.initialize();
  cortex = new Cortex(brain);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); });

async function seed() {
  return (await cortex.learn('Panel', 'fact', text)).neuron!;
}

describe('evidencia explícita en el motor', () => {
  it.each(['session', 'miner'])('current evita inferir historia/miner permanente y envejece sin verificar (%s)', async source => {
    const r = await cortex.learn('Runtime', 'fact', 'Instalado Node20 el 2025-01-01.', { source, temporal: 'current' });
    expect(r.shelf).toMatchObject({ shelf_life: 'volatile', inferred: true, reason: 'version' });
    const f = { ...r.neuron!.facts[0], added: '2025-01-01T00:00:00.000Z' };
    expect(f.verified).toBeUndefined();
    expect(factStaleness(f, {
      nowMs: Date.parse('2026-10-18T00:00:00.000Z'), windows: DEFAULT_SHELF_DAYS,
    })).toMatchObject({ stale: true, shelf_life: 'volatile' });
    expect(shelfOfFact({ ...f, shelf_life: 'permanent' })).toEqual({ shelf: 'permanent', inferred: false });
  });
  it('describe legacy sin atribuir fuente ni reescribirlo', async () => {
    const n = await seed();
    n.facts[0].verified = earlier;
    const before = JSON.stringify(n);
    expect(describeEvidence(n, n.facts[0].id!, 'fact', text)).toEqual({ verification: { method: 'unspecified', at: earlier } });
    expect(JSON.stringify(n)).toBe(before);
  });
  it('conserva referencia e histórico sin convertirlos en verificación', async () => {
    const r = await cortex.learn('Panel', 'fact', text, { reference, temporal: 'historical' } as any);
    expect(r.neuron!.facts[0]).toMatchObject({ reference, temporal: 'historical' });
    expect(r.neuron!.facts[0].verified).toBeUndefined();
    expect(r.shelf).toMatchObject({ shelf_life: 'permanent' });
    expect(shelfOfFact({ ...r.neuron!.facts[0], shelf_life: 'volatile' }).shelf).toBe('volatile');
    const updated = await cortex.learn('Panel', 'fact', text, {
      reference: { ...reference, field: 'admin.port' }, temporal: 'current',
    } as any);
    expect(updated.updated_in_place).toBe(true);
    expect(updated.neuron!.facts).toHaveLength(1);
    expect(updated.neuron!.facts[0]).toMatchObject({ temporal: 'current', reference: { field: 'admin.port' } });
    expect(updated.neuron!.facts[0].verified).toBeUndefined();
  });

  it('otra sesión aumenta repeticiones sin renovar una verificación previa', async () => {
    const n = await seed();
    n.facts[0].verified = earlier;
    (n.facts[0] as any).verification = { method: 'user', at: earlier };
    await writeJSON(brain.paths.neuron(n.id), n);
    const r = await new Cortex(brain).learn('Panel', 'fact', text);
    expect(r.confirmations).toBe(2);
    expect(r.neuron!.facts[0].verified).toBe(earlier);
    expect((r.neuron!.facts[0] as any).verification).toEqual({ method: 'user', at: earlier });
  });

  it.each([
    { reference: { ...reference, value: 'config/nuevo-panel.json' } },
    { temporal: 'historical' as const },
  ])('cambiar metadatos invalida la verificación y el log antiguo no la restaura: %j', async change => {
    const n = (await cortex.learn('Panel', 'fact', text, { reference, temporal: 'current' })).neuron!;
    await cortex.verify(n.id, { facts: [text], evidence: { method: 'source', reference } });
    const checked = (await cortex.peek(n.id))!;
    const old = checked.facts[0];
    await getIdentity(brain, 'yo');
    await writeJSON(path.join(spaceDir(brain, 'equipo'), 'space.json'), { v: 1, name: 'equipo' });
    await markShared(brain, n.id, 'equipo');
    attachSync(brain, cortex);
    const r = await cortex.learn('Panel', 'fact', text, change);
    const f = r.neuron!.facts[0];
    expect(f.verified).toBeUndefined();
    expect(f.verification).toBeUndefined();
    const common = { v: 1, nid: n.id, by: 'ana' };
    const opsDir = path.join(spaceDir(brain, 'equipo'), 'neurons', n.id, 'ops');
    const raw = (await Promise.all((await fs.readdir(opsDir)).map(file => fs.readFile(path.join(opsDir, file), 'utf8')))).join('\n');
    const ops = [
      ...decodeOps(raw).ops,
      { ...common, op: 'verify', eid: f.id, ekind: 'fact', at: old.verified, verification: old.verification },
    ] as Op[];
    for (const order of [ops, [...ops].reverse()]) {
      const replay = applyOps(checked, order).neuron.facts[0];
      expect(replay.verified).toBeUndefined();
      expect(replay.verification).toBeUndefined();
      expect(replay.reference).toEqual(f.reference);
      expect(replay.temporal).toBe(f.temporal);
    }
    for (const joined of [unionNeuron(checked, r.neuron!).neuron, unionNeuron(r.neuron!, checked).neuron]) {
      expect(joined.facts[0].verified).toBeUndefined();
      expect(joined.facts[0].verification).toBeUndefined();
    }
    const verified = await cortex.verify(n.id, { facts: [text], evidence: { method: 'user' } });
    expect(verified.neuron!.facts[0].verification?.at).toBe(verified.neuron!.facts[0].verified);
    expect(verified.neuron!.facts[0].verification?.method).toBe('user');
    const next = { ...common, op: 'verify', eid: f.id, ekind: 'fact', at: verified.neuron!.facts[0].verified,
      verification: verified.neuron!.facts[0].verification } as Op;
    expect(applyOps(checked, [...ops, next]).neuron.facts[0].verification?.method).toBe('user');
  });

  it('verify guarda el método declarado y la referencia en hechos y entradas', async () => {
    const n = await seed();
    await cortex.learn('Panel', 'pattern', pattern);
    await cortex.verify(n.id, { facts: [text], entries: [pattern], evidence: { method: 'source', reference } } as any);
    const saved: any = await cortex.peek(n.id);
    expect(saved.facts[0].verification).toEqual({ method: 'source', reference, at: saved.facts[0].verified });
    expect(saved.entry_verification[entryId(pattern)]).toEqual({ method: 'source', reference, at: saved.entry_verified[entryId(pattern)] });
    await cortex.verify(n.id, { facts: [text], evidence: { method: 'user' } } as any);
    expect((await cortex.peek(n.id))!.facts[0]).toMatchObject({ verification: { method: 'user' } });
    await cortex.verify(n.id, { facts: [text] });
    const legacy: any = (await cortex.peek(n.id))!.facts[0];
    expect(legacy.verification).toEqual({ method: 'unspecified', at: legacy.verified });
  });

  it.each([
    { method: 'source' },
    { method: 'inventado' },
    { method: 'source', reference: { kind: 'url', value: 'https://user:pass@example.test/a' } },
    { method: 'source', reference: { kind: 'url', value: 'https://example.test/a?access_token=ficticio' } },
    { method: 'source', reference: { kind: 'url', value: `https://example.test/a?opaque=ghp%5F${'a'.repeat(36)}` } },
    { method: 'source', reference: { kind: 'url', value: 'javascript:alert(1)' } },
    { method: 'source', reference: { kind: 'file', value: '' } },
  ])('rechaza evidencia inválida antes de escribir: %j', async evidence => {
    const n = await seed();
    await expect(cortex.verify(n.id, { facts: [text], evidence } as any)).rejects.toThrow();
    expect((await cortex.peek(n.id))!.facts[0].verified).toBeUndefined();
  });

  it('redacta secretos en referencias de archivo y rechaza referencias URL inseguras al aprender', async () => {
    const r = await cortex.learn('Panel', 'fact', text, {
      reference: { kind: 'person', value: 'Persona de prueba', field: 'password: Ficticia123!Segura' },
    } as any);
    expect(JSON.stringify(r.neuron)).not.toContain('Ficticia123!Segura');
    expect((r.neuron!.facts[0] as any).reference?.field).toBeTruthy();
    await expect(cortex.learn('Otra', 'fact', text, {
      reference: { kind: 'url', value: 'https://example.test/?api_key=ficticia' },
    } as any)).rejects.toThrow();
    expect(await cortex.findByName('Otra')).toBeNull();
  });

  it('moveEntries transporta la evidencia y forget poda el sidecar', async () => {
    const n = await seed();
    await cortex.learn('Panel', 'pattern', pattern);
    await cortex.verify(n.id, { facts: [text], entries: [pattern], evidence: { method: 'source', reference } } as any);
    const moved = await cortex.moveEntries(n.id, [text, pattern], 'Operaciones');
    const target: any = await cortex.peek(moved.into!);
    expect(target.facts[0].verification).toMatchObject({ method: 'source', reference });
    expect(target.entry_verification[entryId(pattern)]).toMatchObject({ method: 'source', reference });
    expect((await cortex.peek(n.id)) as any).not.toHaveProperty('entry_verification');
    await cortex.forget(target.id, [pattern]);
    expect(await cortex.peek(target.id)).not.toHaveProperty('entry_verification');
  });
});


describe('evidencia compartida', () => {
  it('el dry run bloquea credenciales en referencias cargadas directamente desde disco', async () => {
    const n: any = await seed();
    n.facts[0].reference = { kind: 'url', value: 'https://example.test/?token=ficticio' };
    await writeJSON(brain.paths.neuron(n.id), n);
    await writeJSON(path.join(spaceDir(brain, 'equipo'), 'space.json'), { v: 1, name: 'equipo' });
    const prep = await prepareShare(brain, cortex, n.id, 'equipo');
    if ('error' in prep) throw new Error(prep.error);
    expect(prep.blocked.length).toBeGreaterThan(0);
    expect(prep.confirm_token).toBeUndefined();
  });
  it('mergeNeurons emite evidencia nueva aunque el hecho ya exista en el destino', async () => {
    const source = await seed();
    const target = (await cortex.learn('Destino', 'fact', text)).neuron!;
    await cortex.learn('Panel', 'fact', text, { reference, temporal: 'current' });
    // La comprobación debe ser posterior al cambio de referencia/temporalidad.
    await cortex.verify(source.id, { facts: [text], evidence: { method: 'source', reference } });
    await getIdentity(brain, 'yo');
    await writeJSON(path.join(spaceDir(brain, 'equipo'), 'space.json'), { v: 1, name: 'equipo' });
    await markShared(brain, target.id, 'equipo');
    attachSync(brain, cortex);
    await cortex.mergeNeurons(source.id, target.id);
    const opsDir = path.join(spaceDir(brain, 'equipo'), 'neurons', target.id, 'ops');
    const files = await fs.readdir(opsDir).catch(() => []);
    const raw = (await Promise.all(files.map(f => fs.readFile(path.join(opsDir, f), 'utf8')))).join('\n');
    const replay = applyOps(target, decodeOps(raw).ops).neuron;
    expect(replay.facts[0].verification).toMatchObject({ method: 'source', reference });
    expect(replay.facts[0]).toMatchObject({ reference, temporal: 'current' });
  });

  it('un verify inválido no convierte una fecha en comprobación atribuida', async () => {
    const n = await seed();
    const ops = [{ v: 1, nid: n.id, by: 'ana', at, op: 'verify', eid: n.facts[0].id, ekind: 'fact',
      verification: { method: 'source', at, reference: { kind: 'url', value: 'https://example.test/?token=ficticio' } },
    }] as Op[];
    const f = applyOps(n, ops).neuron.facts[0];
    expect(f.verified).toBeUndefined();
    expect(f.verification).toBeUndefined();
  });

  it('referencias y temporalidad convergen en ambos órdenes y conservan datos en el replay', async () => {
    const n = await seed();
    const common = { v: 1, nid: n.id, by: 'ana', at, op: 'fact', fid: n.facts[0].id, text, conf: 1 };
    const ops = [{ ...common, reference, temporal: 'historical' },
      { ...common, reference: { kind: 'file', value: 'z-config.json' }, temporal: 'current' }] as Op[];
    const a = applyOps(n, ops).neuron;
    const b = applyOps(n, [...ops].reverse()).neuron;
    expect(a.facts[0]).toMatchObject({ reference: { kind: 'file', value: 'z-config.json' }, temporal: 'current' });
    expect(b.facts).toEqual(a.facts);
    expect(applyOps(a, ops).neuron.facts).toEqual(a.facts);
  });
  it('viaja por los logs reales al compartir y al emitir nuevas verificaciones', async () => {
    await getIdentity(brain, 'yo');
    await writeJSON(path.join(spaceDir(brain, 'equipo'), 'space.json'), { v: 1, name: 'equipo', created_by: 'yo', created: at, branch: 'main' });
    const n = (await cortex.learn('Panel', 'fact', text, { reference, temporal: 'historical' } as any)).neuron!;
    await cortex.verify(n.id, { facts: [text], evidence: { method: 'source', reference } } as any);
    const prep = await prepareShare(brain, cortex, n.id, 'equipo');
    if ('error' in prep) throw new Error(prep.error);
    expect((await commitShare(brain, cortex, n.id, 'equipo', prep.confirm_token!)).ok).toBe(true);
    attachSync(brain, cortex);
    await cortex.learn('Panel', 'pattern', pattern);
    await cortex.verify(n.id, { entries: [pattern], evidence: { method: 'user' } } as any);
    const opsDir = path.join(spaceDir(brain, 'equipo'), 'neurons', n.id, 'ops');
    const raw = (await Promise.all((await fs.readdir(opsDir)).map(f => fs.readFile(path.join(opsDir, f), 'utf8')))).join('\n');
    const replay: any = applyOps(null, decodeOps(raw).ops, { id: n.id }).neuron;
    expect(replay.facts[0]).toMatchObject({ reference, temporal: 'historical', verification: { method: 'source', reference } });
    expect(replay.entry_verification[entryId(pattern)]).toMatchObject({ method: 'user' });
  });

  it('fusión, replay y union eligen la misma evidencia completa, sin mutar las entradas', async () => {
    const n = await seed();
    const fid = n.facts[0].id!;
    const common = { v: 1, nid: n.id, by: 'ana', at };
    const ops = [
      { ...common, op: 'fact', fid, text, conf: 1, reference, temporal: 'historical' },
      { ...common, op: 'verify', eid: fid, ekind: 'fact', verification: { method: 'source', at, reference } },
      { ...common, op: 'verify', eid: fid, ekind: 'fact', verification: { method: 'user', at } },
    ] as Op[];
    const serialized = JSON.stringify(n);
    const a: any = applyOps(n, ops).neuron;
    const b: any = applyOps(n, [...ops].reverse()).neuron;
    expect(a.facts[0].verification).toBeDefined();
    expect(b.facts[0]).toEqual(a.facts[0]);
    expect(applyOps(a, ops).neuron.facts).toEqual(a.facts);
    expect(JSON.stringify(n)).toBe(serialized);
    const older: any = structuredClone(n);
    older.facts[0].verified = earlier;
    older.facts[0].verification = { method: 'source', at: earlier, reference };
    expect(unionNeuron(older, a).neuron.facts[0]).toMatchObject({ verification: a.facts[0].verification, reference, temporal: 'historical' });
    expect(unionNeuron(a, older).neuron.facts[0]).toMatchObject({ verification: a.facts[0].verification });
  });

  it('una fecha legacy posterior no hereda la referencia de una comprobación antigua', async () => {
    const n: any = await seed();
    n.facts[0].verified = earlier;
    n.facts[0].verification = { method: 'source', at: earlier, reference };
    const newer = { v: 1, op: 'verify', nid: n.id, by: 'ana', at, eid: n.facts[0].id, ekind: 'fact' } as Op;
    const f: any = applyOps(n, [newer]).neuron.facts[0];
    expect(f.verified).toBe(at);
    expect(f.verification?.method).not.toBe('source');
    expect(f.verification?.reference).toBeUndefined();
  });

  it('una purga elimina la evidencia de entradas aunque verify llegue después', async () => {
    const n = await seed();
    const k = entryId(pattern);
    const common = { v: 1, nid: n.id, by: 'ana', at };
    const ops = [
      { ...common, op: 'pattern', text: pattern },
      { ...common, op: 'purge', pkind: 'pattern', key: k },
      { ...common, op: 'verify', eid: k, ekind: 'entry', verification: { method: 'source', reference, at } },
    ] as Op[];
    for (const ordered of [ops, [...ops].reverse()]) {
      const replay = applyOps(n, decodeOps(ordered.map(encodeOp).join('\n')).ops).neuron;
      expect(replay.patterns).not.toContain(pattern);
      expect(replay).not.toHaveProperty('entry_verification');
      expect(replay).not.toHaveProperty('entry_verified');
    }
  });
});
