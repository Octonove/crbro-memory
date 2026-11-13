// 2.11 shared spaces: names cannot walk out of shared/, remotes cannot carry
// credentials or options, a teammate cannot adopt your private neurons, and
// what arrives from the remote is checked before it is merged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import * as storage from '../src/utils/fs.js';
import * as transport from '../src/sync/git.js';
import {
  createSpace, joinSpace, getIdentity, prepareShare, readSpace, sharedMap, spaceDir, syncSpaceNow, markShared,
} from '../src/sync/space.js';
import {
  spaceNameProblem, remoteProblem, branchProblem, safeSpaceDir, sanitizeIncomingOps,
} from '../src/sync/validate.js';
import { encodeOp, entryId, opsRelPath, type Op } from '../src/sync/ops.js';

let root: string;
let brain: Brain;
let cortex: Cortex;
const fecha = '2026-11-13T10:00:00.000Z';
const J = (...p: string[]) => p.join('');

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-sync-validate-'));
  brain = new Brain(path.join(root, 'brain'));
  await brain.initialize();
  cortex = new Cortex(brain);
  await getIdentity(brain, 'yo');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('space names (G1)', () => {
  const malos = ['..', '../x', '../../.ssh', '/abs', 'C:\\Windows', 'a/b', 'a\\b', '.hidden', '-x', '',
    '．．', 'é', 'a\u0000b', 'con', 'NUL', 'x'.repeat(65), ' equipo', 'equipo '];
  for (const n of malos) {
    it(`refuses ${JSON.stringify(n).slice(0, 20)}`, async () => {
      expect(spaceNameProblem(n)).not.toBeNull();
      expect(() => spaceDir(brain, n)).toThrow(/Invalid space name/);
      expect(await readSpace(brain, n)).toBeNull();
      const r = await createSpace(brain, n, path.join(root, 'remote.git'), 'yo');
      expect(r.ok).toBe(false);
    });
  }

  it('accepts ordinary names and keeps them inside shared/', () => {
    for (const n of ['equipo', 'Team-1', 'a_b', '9lives']) {
      expect(spaceNameProblem(n)).toBeNull();
      const dir = safeSpaceDir(brain.paths.shared, n);
      expect(path.relative(brain.paths.shared, dir)).toBe(n);
    }
  });

  it('create with ".." never touches the brain root', async () => {
    const before = await fs.readdir(brain.paths.root);
    const r = await createSpace(brain, '..', path.join(root, 'remote.git'), 'yo');
    expect(r.ok).toBe(false);
    expect(await fs.readdir(brain.paths.root)).toEqual(before);
    await expect(fs.stat(path.join(brain.paths.root, '.git'))).rejects.toThrow();
  });
});

describe('remotes and branches (G16)', () => {
  it('refuses credentials, options and control characters', () => {
    expect(remoteProblem('https://' + J('ana:', 'fake-pass') + '@example.com/r.git')).toMatch(/credentials/);
    expect(remoteProblem('https://' + J('ghp_', 'x'.repeat(36)) + '@github.com/a/b.git')).toMatch(/credential/);
    expect(remoteProblem('--upload-pack=touch /tmp/x')).toMatch(/"-"/);
    expect(remoteProblem('git@host:a/b.git\nx')).toMatch(/control/);
  });

  it('accepts ssh, scp-like, https without userinfo and local paths', () => {
    for (const r of ['git@github.com:acme/team.git', 'ssh://git@example.com/acme/team.git',
      'https://example.com/acme/team.git', path.join(root, 'remote.git'), 'file:///srv/git/team.git']) {
      expect(remoteProblem(r), r).toBeNull();
    }
  });

  it('branches follow check-ref-format', () => {
    for (const b of ['-x', 'a..b', 'x.lock', 'a//b', 'a/', '@{u}', '']) expect(branchProblem(b), b).not.toBeNull();
    for (const b of ['main', 'release/2.11', 'team_memory']) expect(branchProblem(b), b).toBeNull();
  });

  it('a credentialed remote is refused before git runs, so it never reaches .git/config', async () => {
    const r = await joinSpace(brain, 'equipo', 'https://' + J('ana:', 'fake-pass') + '@example.com/r.git', 'yo');
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain('fake-pass');
    await expect(fs.stat(path.join(brain.paths.shared, 'equipo'))).rejects.toThrow();
  });
});

async function espacioCon(nid: string, ops: Op[]): Promise<void> {
  await storage.writeJSON(path.join(spaceDir(brain, 'equipo'), 'space.json'), {
    v: 1, name: 'equipo', created_by: 'ana', created: fecha, branch: 'main',
  });
  const file = path.join(spaceDir(brain, 'equipo'), opsRelPath(nid, 'ana', 'fixture'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, ops.map(encodeOp).join('\n') + '\n');
  vi.spyOn(transport, 'syncSpaceAsync').mockResolvedValue({
    pulled: { ok: true, stdout: '', stderr: '' }, pushed: { ok: true, stdout: '', stderr: '' },
  });
}

describe('sync never adopts a private neuron (G2)', () => {
  it('a remote folder with the id of a local, unshared neuron is left alone', async () => {
    const nid = 'project_privada';
    await cortex.learn('Privada', 'fact', 'Dato solo mío', { neuronId: nid, neuronType: 'project' });
    const antes = await fs.readFile(brain.paths.neuron(nid), 'utf8');
    await espacioCon(nid, [{ v: 1, op: 'fact', nid, by: 'intruso', at: fecha, fid: entryId('Plantado'), text: 'Plantado', conf: 1 }]);
    const r = await syncSpaceNow(brain, cortex, 'equipo');
    expect(r.left_alone).toEqual([nid]);
    expect(r.message).toMatch(/left alone/);
    expect(await sharedMap(brain)).toEqual({});
    expect(await fs.readFile(brain.paths.neuron(nid), 'utf8')).toBe(antes);
  });

  it('once you share it, the same folder merges', async () => {
    const nid = 'project_privada';
    await cortex.learn('Privada', 'fact', 'Dato solo mío', { neuronId: nid, neuronType: 'project' });
    await espacioCon(nid, [{ v: 1, op: 'fact', nid, by: 'ana', at: fecha, fid: entryId('Del equipo'), text: 'Del equipo', conf: 1 }]);
    await markShared(brain, nid, 'equipo');
    const r = await syncSpaceNow(brain, cortex, 'equipo');
    expect(r.left_alone).toBeUndefined();
    expect((await cortex.peek(nid))!.facts.map(f => f.text)).toContain('Del equipo');
  });

  it('a neuron new to this machine is created and followed, as before', async () => {
    const nid = 'project_nueva';
    await espacioCon(nid, [{ v: 1, op: 'fact', nid, by: 'ana', at: fecha, fid: entryId('Hola'), text: 'Hola', conf: 1 }]);
    const r = await syncSpaceNow(brain, cortex, 'equipo');
    expect(r.neurons_touched).toEqual([nid]);
    expect(await sharedMap(brain)).toEqual({ [nid]: 'equipo' });
  });
});

describe('incoming data is checked (G5)', () => {
  it('an op naming another neuron cannot steer where a neuron is written', async () => {
    const nid = 'project_destino';
    await espacioCon(nid, [
      { v: 1, op: 'neuron', nid: '../../escape', by: 'x', at: fecha, name: 'Escape', ntype: 'project', domain: 'x' },
      { v: 1, op: 'fact', nid: '../../escape', by: 'x', at: fecha, fid: 'f1', text: 'fuera', conf: 1 },
      { v: 1, op: 'fact', nid, by: 'ana', at: fecha, fid: 'f2', text: 'dentro', conf: 1 },
    ] as Op[]);
    const r = await syncSpaceNow(brain, cortex, 'equipo');
    expect(r.ops_dropped).toBe(2);
    const n = await cortex.peek(nid);
    expect(n!.id).toBe(nid);
    expect(n!.facts.map(f => f.text)).toEqual(['dentro']);
    await expect(fs.stat(path.join(root, 'escape.json'))).rejects.toThrow();
  });

  it('folders that are not neuron ids are ignored', async () => {
    await espacioCon('Bad Name', [{ v: 1, op: 'fact', nid: 'Bad Name', by: 'a', at: fecha, fid: 'f', text: 't', conf: 1 }] as Op[]);
    const r = await syncSpaceNow(brain, cortex, 'equipo');
    expect(r.neurons_touched).toEqual([]);
  });

  it('sanitises author, confidence, text and kinds', () => {
    const secreto = J('ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789AB');
    const { ops, dropped } = sanitizeIncomingOps('project_x', [
      { v: 1, op: 'fact', nid: 'project_x', by: 'Ana <script>\n', at: fecha, fid: 'f', text: `token ${secreto}`, conf: 7 },
      { v: 1, op: 'decision', nid: 'project_x', by: 'b', at: fecha, did: 'd', text: 'x', why: `por ${secreto}` },
      { v: 1, op: 'bogus', nid: 'project_x', by: 'b', at: fecha },
      { v: 1, op: 'fact', nid: 'project_x', by: 'b', at: fecha, fid: 'f', text: 42, conf: 1 },
      { v: 1, op: 'status', nid: 'project_x', by: 'b', at: fecha, fid: 'f', to: 'active' },
    ] as unknown as Op[]);
    expect(dropped).toBe(3);
    expect(ops[0]).toMatchObject({ by: 'anascript', conf: 1 });
    expect(JSON.stringify(ops)).not.toContain(secreto);
  });
});

describe('what a share checks (G8)', () => {
  it('a credential in a rationale, an alias or a revision note blocks the share', async () => {
    await storage.writeJSON(path.join(spaceDir(brain, 'equipo'), 'space.json'), {
      v: 1, name: 'equipo', created_by: 'yo', created: fecha, branch: 'main',
    });
    const secreto = J('ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789AB');
    const nid = 'project_compartir';
    await cortex.learn('Compartir', 'fact', 'Hecho limpio', { neuronId: nid, neuronType: 'project' });
    await storage.updateJSON<any>(brain.paths.neuron(nid), n => ({
      ...n,
      decisions: [{ text: 'Usar el despliegue nuevo', date: fecha, rationale: `porque el token ${secreto} caduca` }],
      facts: n.facts.map((f: any) => ({ ...f, keys: [secreto], revision_note: `nota ${secreto}` })),
    }));
    const r = await prepareShare(brain, cortex, nid, 'equipo');
    if ('error' in r) throw new Error(r.error);
    const where = r.blocked.map(b => b.where);
    expect(where).toEqual(expect.arrayContaining(['decisions[0].rationale', 'facts[0].keys[0]', 'facts[0].revision_note']));
    expect(r.confirm_token).toBeUndefined();
  });
});

describe('learn, revise and audit see every stored field (G8)', () => {
  const secreto = J('ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789AB');

  it('rationale and keys are redacted on learn; notes on revise', async () => {
    await cortex.learn('Campos', 'decision', 'Rotar el token', { rationale: `el viejo era ${secreto}`, neuronType: 'project' });
    const r = await cortex.learn('Campos', 'fact', 'Un hecho', { keys: [secreto, 'alias'] });
    await cortex.revise(r.neuron!.id, ['Un hecho'], { status: 'retracted', note: `por ${secreto}` });
    const raw = await fs.readFile(brain.paths.neuron(r.neuron!.id), 'utf8');
    expect(raw).not.toContain(secreto);
    expect(raw).toContain('[REDACTED: GitHub token]');
  });

  it('audit counts a credential sitting in a rationale or an alias', async () => {
    const nid = 'project_auditada';
    await cortex.learn('Auditada', 'fact', 'Limpio', { neuronId: nid, neuronType: 'project' });
    await storage.updateJSON<any>(brain.paths.neuron(nid), n => ({
      ...n,
      decisions: [{ text: 'Decisión', date: fecha, rationale: `token ${secreto}` }],
      facts: n.facts.map((f: any) => ({ ...f, keys: [secreto] })),
    }));
    const hallazgos = await cortex.auditSecrets();
    expect(hallazgos.find(h => h.neuron_id === nid)).toMatchObject({ facts: 1, decisions: 1 });
  });
});

describe.runIf(process.platform === 'win32')('git is resolved, never taken from the space folder (G10)', () => {
  it('a git.exe planted in the space directory does not run', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-planted-'));
    try {
      copyFileSync(process.execPath, path.join(dir, 'git.exe'));   // node.exe would print v24…
      transport._resetGitMemoForTests();
      expect(path.isAbsolute(transport.resolveGit())).toBe(true);
      expect(path.dirname(transport.resolveGit())).not.toBe(dir);
      expect(transport.git(['--version'], dir).stdout).toMatch(/^git version/);
      expect((await transport.gitAsync(['--version'], dir)).stdout).toMatch(/^git version/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
