import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { SearchEngine } from '../src/search/index.js';
import * as storage from '../src/utils/fs.js';
import * as locking from '../src/utils/lock.js';
import * as transport from '../src/sync/git.js';
import {
  attachSync, createSpace, emitOps, getIdentity, leaveSpace, listSpaces,
  markShared, readSpace, sharedMap, spaceDir, syncSpaceNow,
} from '../src/sync/space.js';
import { decodeOps, encodeOp, entryId, opsRelPath, type Op } from '../src/sync/ops.js';

let root: string;
let brain: Brain;
let cortex: Cortex;
const nid = 'project_integridad';
const fecha = '2026-10-18T10:00:00.000Z';
const fact = (text: string): Op => ({
  v: 1, op: 'fact', nid, by: 'ana', at: fecha, fid: entryId(text), text, conf: 1,
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-integridad-sync-'));
  brain = new Brain(path.join(root, 'brain'));
  await brain.initialize();
  cortex = new Cortex(brain);
  await getIdentity(brain, 'yo');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

async function espacio(ops: Op[] = [fact('Nota del equipo')]): Promise<void> {
  await storage.writeJSON(path.join(spaceDir(brain, 'equipo'), 'space.json'), {
    v: 1, name: 'equipo', created_by: 'ana', created: fecha, branch: 'main',
  });
  await log(ops);
  // Solo se sustituye el transporte: lectura, fusión, persistencia e índice son reales.
  vi.spyOn(transport, 'syncSpace').mockReturnValue({
    pulled: { ok: true, stdout: '', stderr: '' },
    pushed: { ok: false, stdout: '', stderr: 'rechazado', reason: 'auth' },
  });
}

async function log(ops: Op[]): Promise<string> {
  const file = path.join(spaceDir(brain, 'equipo'), opsRelPath(nid, 'ana', 'fixture'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, ops.map(encodeOp).join('\n') + '\n');
  return file;
}

// Intercalado determinista: la otra escritura termina justo antes de que sync
// adquiera el bloqueo de la neurona. El snapshot antiguo pierde esa escritura.
function antesDeGuardarSync(write: () => Promise<void>): void {
  const update = storage.updateJSON;
  let pendiente = true;
  vi.spyOn(storage, 'updateJSON').mockImplementation(async (file, mutate) => {
    if (file === brain.paths.neuron(nid) && pendiente) {
      pendiente = false;
      await write();
    }
    return update(file, mutate);
  });
}

describe('integridad de la fusión', () => {
  it('conserva learn intercalado y lo mantiene recuperable en el índice real', async () => {
    await cortex.learn('Integridad', 'fact', 'Base local', { neuronId: nid });
    await espacio();
    const search = new SearchEngine(brain);
    await search.init();
    cortex.setIndexer(n => search.indexNeuron(n));
    antesDeGuardarSync(async () => {
      await cortex.learn('Integridad', 'fact', 'El zafiro violeta está en el almacén.', { neuronId: nid });
    });

    const result = await syncSpaceNow(brain, cortex, 'equipo');
    expect((await cortex.peek(nid))!.facts.map(f => f.text)).toEqual(
      expect.arrayContaining(['Base local', 'Nota del equipo', 'El zafiro violeta está en el almacén.']),
    );
    expect((await search.search('zafiro violeta'))[0]?.neuron_id).toBe(nid);
    expect(result.merged[0].facts_added).toBe(1);
  });

  it('conserva retiros locales que terminan antes del bloqueo de sync', async () => {
    await cortex.learn('Integridad', 'fact', 'Dato obsoleto', { neuronId: nid });
    await cortex.learn('Integridad', 'pattern', 'Patrón retirado', { neuronId: nid });
    await espacio();
    antesDeGuardarSync(async () => {
      await cortex.revise(nid, ['Dato obsoleto'], { status: 'retracted' });
      await cortex.retireEntries(nid, ['Patrón retirado'], { status: 'superseded' });
    });
    await syncSpaceNow(brain, cortex, 'equipo');
    const saved = (await cortex.peek(nid))!;
    expect(saved.facts.find(f => f.text === 'Dato obsoleto')?.status).toBe('retracted');
    expect(saved.entry_status?.[entryId('Patrón retirado')]?.status).toBe('superseded');
  });

  it('aplica purgas y conserva campos locales al repetir un log', async () => {
    await cortex.learn('Integridad', 'error', 'Error ya eliminado', { neuronId: nid });
    await storage.updateJSON<any>(brain.paths.neuron(nid), n => ({ ...n,
      heat: 0.83, access_count: 27, last_accessed: fecha, created: '2020-01-01',
      summary: 'Resumen local', preferences: ['Preferencia privada'], connections: ['project_otro'],
    }));
    await espacio([{ v: 1, op: 'purge', nid, by: 'ana', at: fecha,
      pkind: 'error', key: entryId('Error ya eliminado') }]);
    const first = await syncSpaceNow(brain, cortex, 'equipo');
    expect(first.merged[0].entries_removed).toBe(1);
    expect((await syncSpaceNow(brain, cortex, 'equipo')).neurons_touched).toEqual([]);
    expect(await cortex.peek(nid)).toMatchObject({
      errors: [], heat: 0.83, access_count: 27, last_accessed: fecha, created: '2020-01-01',
      summary: 'Resumen local', preferences: ['Preferencia privada'], connections: ['project_otro'],
    });
  });

  it('crea una neurona anunciada sin hechos y no vuelve a anunciar un cambio al repetirla', async () => {
    await espacio([{ v: 1, op: 'neuron', nid, by: 'ana', at: fecha,
      name: 'Integridad', ntype: 'project', domain: 'pruebas' }]);
    expect((await syncSpaceNow(brain, cortex, 'equipo')).neurons_touched).toEqual([nid]);
    expect(await cortex.peek(nid)).toMatchObject({ name: 'Integridad', domain: 'pruebas' });
    expect((await syncSpaceNow(brain, cortex, 'equipo')).neurons_touched).toEqual([]);
  });
});

describe('salida recuperable', () => {
  it('no afirma envío si pull funciona pero push es rechazado y conserva todo el log', async () => {
    await espacio();
    await cortex.learn('Integridad', 'fact', 'Nota local pendiente', { neuronId: nid });
    await markShared(brain, nid, 'equipo');
    attachSync(brain, cortex);
    await cortex.learn('Integridad', 'fact', 'Otra nota sin enviar', { neuronId: nid });
    const id = await getIdentity(brain);
    const rel = opsRelPath(nid, id.author, id.device);
    const bytes = await fs.readFile(path.join(spaceDir(brain, 'equipo'), rel), 'utf8');
    const result = await leaveSpace(brain, cortex, 'equipo');

    expect(result.synced_before_leaving).toBe('ok');
    expect(result.message).not.toContain('Your pending notes went out first');
    expect(result).toMatchObject({ ok: true, pushed_before_leaving: false, neurons_unshared: 1 });
    const archive = (result as { archive_path?: string }).archive_path!;
    expect(archive).toBeTruthy();
    expect(path.relative(brain.paths.shared, archive).startsWith('..')).toBe(true);
    expect(await fs.readFile(path.join(archive, rel), 'utf8')).toBe(bytes);
    expect(await listSpaces(brain)).toEqual([]);
    expect(await sharedMap(brain)).toEqual({});
    expect((await cortex.peek(nid))!.facts.map(f => f.text)).toEqual(expect.arrayContaining([
      'Nota local pendiente', 'Otra nota sin enviar', 'Nota del equipo',
    ]));
  });

  it('si falla el archivo deja el espacio, su pertenencia y sus logs recuperables', async () => {
    await espacio();
    await markShared(brain, nid, 'equipo');
    const file = await log([fact('No se puede perder')]);
    const bytes = await fs.readFile(file, 'utf8');
    // Fallo real de filesystem: el padre del archivo no puede ser un directorio.
    await fs.writeFile(path.join(brain.paths.root, 'shared-archives'), 'obstáculo');
    const result = await leaveSpace(brain, cortex, 'equipo');
    expect(result.ok).toBe(false);
    expect(await readSpace(brain, 'equipo')).not.toBeNull();
    expect(await sharedMap(brain)).toEqual({ [nid]: 'equipo' });
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
  });

  it('serializa emisión y salida sin perder una operación ya en curso', async () => {
    await espacio();
    await markShared(brain, nid, 'equipo');
    const append = fs.appendFile.bind(fs);
    let finish!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>(r => { finish = r; });
    const reached = new Promise<void>(r => { started = r; });
    vi.spyOn(fs, 'appendFile').mockImplementation(async (...args) => {
      started();
      await blocked;
      return append(...args);
    });
    const emitting = emitOps(brain, nid, () => [fact('Emisión simultánea')]);
    await reached;
    let competing!: () => void;
    const attempted = new Promise<void>(r => { competing = r; });
    const lock = locking.withLock;
    vi.spyOn(locking, 'withLock').mockImplementation((target, fn) => {
      if (target === path.join(brain.paths.root, 'shared-state')) competing();
      return lock(target, fn);
    });
    const leaving = leaveSpace(brain, cortex, 'equipo');
    // Sin temporizadores: la versión segura llega al bloqueo; la antigua
    // termina de salir mientras append sigue suspendido.
    await Promise.race([attempted, leaving]);
    finish();
    const outcomes = await Promise.allSettled([emitting, leaving]);
    expect(outcomes.every(r => r.status === 'fulfilled')).toBe(true);
    const result = await leaving;
    const archive = (result as { archive_path?: string }).archive_path!;
    expect(archive).toBeTruthy();
    const id = await getIdentity(brain);
    const ops = decodeOps(await fs.readFile(path.join(archive, opsRelPath(nid, id.author, id.device)), 'utf8')).ops;
    expect(ops.some(o => o.op === 'fact' && o.text === 'Emisión simultánea')).toBe(true);
    expect(await listSpaces(brain)).toEqual([]);
  });

  it('conserva todas las altas concurrentes del mapa compartido', async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => markShared(brain, `project_${i}`, 'equipo')));
    expect(Object.keys(await sharedMap(brain)).sort()).toEqual([
      'project_0', 'project_1', 'project_2', 'project_3',
      'project_4', 'project_5', 'project_6', 'project_7',
    ]);
  });

  it('archiva incluso después de enviar con éxito a un repositorio bare local', async () => {
    const remote = path.join(root, 'remote.git');
    await fs.mkdir(remote);
    expect(transport.git(['init', '--bare', '-b', 'main'], remote).ok).toBe(true);
    expect((await createSpace(brain, 'equipo', remote, 'yo')).ok).toBe(true);
    await markShared(brain, nid, 'equipo');
    attachSync(brain, cortex);
    await cortex.learn('Integridad', 'fact', 'Nota enviada al bare', { neuronId: nid });
    const result = await leaveSpace(brain, cortex, 'equipo');
    expect(result).toMatchObject({ ok: true, pushed_before_leaving: true });
    const archive = (result as { archive_path?: string }).archive_path!;
    expect(archive).toBeTruthy();
    expect(transport.git(['rev-parse', 'HEAD'], archive).stdout.trim()).toBe(
      transport.git(['rev-parse', 'refs/heads/main'], remote).stdout.trim(),
    );
    expect(await listSpaces(brain)).toEqual([]);
    expect((await cortex.peek(nid))!.facts.some(f => f.text === 'Nota enviada al bare')).toBe(true);
  }, 30_000);
});

describe('entrega persistente sin esperar a Git', () => {
  it('learn con shared-state ocupado se entrega tras liberar y reiniciar, sin duplicar al repetir sync', async () => {
    await espacio();
    await markShared(brain, nid, 'equipo');
    attachSync(brain, cortex);
    const target = path.join(brain.paths.root, 'shared-state');
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const ready = new Promise<void>(r => { entered = r; });
    const lock = locking.withLock;
    const holder = lock(target, async () => { entered(); await gate; });
    await ready;
    // El lock es real; solo adelantamos su timeout para no esperar 15 s.
    const blocked = vi.spyOn(locking, 'withLock').mockImplementation((file, fn) => {
      if (file === target) return Promise.reject(new Error('Timed out waiting for lock: shared-state'));
      return lock(file, fn);
    });
    try {
      await cortex.learn('Integridad', 'fact', 'Nota escrita mientras Git no responde', { neuronId: nid });
      await cortex.verify(nid, { facts: ['Nota escrita mientras Git no responde'], evidence: { method: 'user' } });
      expect((await cortex.peek(nid))!.facts.some(f => f.text === 'Nota escrita mientras Git no responde')).toBe(true);
    } finally {
      release();
      await holder;
      blocked.mockRestore();
    }

    // Nada en memoria del emisor anterior puede ayudar al nuevo motor.
    const restarted = new Brain(brain.paths.root);
    await restarted.initialize();
    const next = new Cortex(restarted);
    attachSync(restarted, next);
    await syncSpaceNow(restarted, next, 'equipo');
    await syncSpaceNow(restarted, next, 'equipo');
    const id = await getIdentity(restarted);
    const file = path.join(spaceDir(restarted, 'equipo'), opsRelPath(nid, id.author, id.device));
    const raw = await fs.readFile(file, 'utf8').catch(() => '');
    const ops = decodeOps(raw).ops;
    expect(ops.filter(o => o.op === 'fact' && o.text === 'Nota escrita mientras Git no responde')).toHaveLength(1);
    const peer = new Cortex(new Brain(path.join(root, 'peer')));
    await peer.mergeFromSync(nid, ops);
    expect((await peer.peek(nid))!.facts[0]).toMatchObject({
      text: 'Nota escrita mientras Git no responde', verification: { method: 'user' },
    });
  });

  it('un fallo del log conserva el pendiente para reintentar desde otro motor', async () => {
    await espacio();
    await markShared(brain, nid, 'equipo');
    attachSync(brain, cortex);
    const append = vi.spyOn(fs, 'appendFile').mockRejectedValue(new Error('fallo de escritura del log'));
    await cortex.learn('Integridad', 'fact', 'Pendiente tras fallo del log', { neuronId: nid });
    append.mockRestore();
    const next = new Cortex(new Brain(brain.paths.root));
    await syncSpaceNow(brain, next, 'equipo');
    const id = await getIdentity(brain);
    const raw = await fs.readFile(path.join(spaceDir(brain, 'equipo'), opsRelPath(nid, id.author, id.device)), 'utf8').catch(() => '');
    expect(decodeOps(raw).ops.some(o => o.op === 'fact' && o.text === 'Pendiente tras fallo del log')).toBe(true);
  });

  it('no confirma éxito si no puede persistir el outbox, aunque conserva la nota local', async () => {
    await espacio();
    await markShared(brain, nid, 'equipo');
    attachSync(brain, cortex);
    await fs.writeFile(path.join(brain.paths.root, 'shared-outbox'), 'obstáculo');
    await expect(cortex.learn('Integridad', 'fact', 'Nota sin confirmación de equipo', { neuronId: nid })).rejects.toThrow();
    expect((await cortex.peek(nid))!.facts.some(f => f.text === 'Nota sin confirmación de equipo')).toBe(true);
  });

  it('archiva lo encolado durante el sync final y no lo declara enviado', async () => {
    await espacio();
    await markShared(brain, nid, 'equipo');
    attachSync(brain, cortex);
    vi.mocked(transport.syncSpace).mockReturnValue({
      pulled: { ok: true, stdout: '', stderr: '' }, pushed: { ok: true, stdout: '', stderr: '' },
    });
    const lock = locking.withLock;
    let inMerge = false;
    vi.spyOn(locking, 'withLock').mockImplementation((file, fn) => {
      if (inMerge && file === path.join(brain.paths.root, 'shared-state')) {
        return Promise.reject(new Error('Timed out waiting for lock: shared-state'));
      }
      return lock(file, fn);
    });
    const merge = cortex.mergeFromSync.bind(cortex);
    vi.spyOn(cortex, 'mergeFromSync').mockImplementationOnce(async (...args) => {
      inMerge = true;
      try { await cortex.learn('Integridad', 'fact', 'Llegó después del push', { neuronId: nid }); }
      finally { inMerge = false; }
      return merge(...args);
    });
    const result = await leaveSpace(brain, cortex, 'equipo');
    expect(result).toMatchObject({ ok: true, pushed_before_leaving: false });
    const id = await getIdentity(brain);
    const raw = await fs.readFile(path.join(result.archive_path!, opsRelPath(nid, id.author, id.device)), 'utf8');
    expect(decodeOps(raw).ops.some(o => o.op === 'fact' && o.text === 'Llegó después del push')).toBe(true);
  });

  it.each(['fact', 'pattern', 'error', 'debt'] as const)(
    'reintentar %s tras fallar el outbox recupera la entrega sin duplicar el contenido', async kind => {
      await espacio();
      await markShared(brain, nid, 'equipo');
      attachSync(brain, cortex);
      const text = `Nota ${kind} que debe llegar tras reintentar`;
      const rename = fs.rename.bind(fs);
      let injected = false;
      const fault = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (!injected && String(to).includes(`${path.sep}shared-outbox${path.sep}`)) {
          injected = true;
          throw Object.assign(new Error('fallo sintético del outbox'), { code: 'EIO' });
        }
        return rename(from, to);
      });
      await expect(cortex.learn('Integridad', kind, text, { neuronId: nid })).rejects.toThrow('shared delivery');
      expect(injected).toBe(true);
      fault.mockRestore();

      // Otro motor: la recuperación no depende de una marca en RAM.
      const restarted = new Cortex(new Brain(brain.paths.root));
      attachSync(brain, restarted);
      await restarted.learn('Integridad', kind, text, { neuronId: nid });
      await restarted.learn('Integridad', kind, text, { neuronId: nid });
      await syncSpaceNow(brain, restarted, 'equipo');
      const id = await getIdentity(brain);
      const raw = await fs.readFile(path.join(spaceDir(brain, 'equipo'), opsRelPath(nid, id.author, id.device)), 'utf8').catch(() => '');
      const ops = decodeOps(raw).ops;
      expect(ops.some(o => o.op === kind && 'text' in o && o.text === text)).toBe(true);
      const peer = new Cortex(new Brain(path.join(root, 'peer-retry')));
      await peer.mergeFromSync(nid, ops);
      await peer.mergeFromSync(nid, ops);
      const saved = (await peer.peek(nid))!;
      const entries = kind === 'fact' ? saved.facts.map(f => f.text)
        : kind === 'pattern' ? saved.patterns : kind === 'error' ? saved.errors! : saved.debts!;
      expect(entries.filter(value => value === text)).toHaveLength(1);
      if (kind === 'fact') expect(saved.facts.find(f => f.text === text)?.verification).toBeUndefined();
    },
  );
});
