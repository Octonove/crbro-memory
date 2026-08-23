// ─── Shared memory ───────────────────────────────────────────────
//
// The merge has to be automatic, because nobody is going to resolve a git
// conflict by hand in the middle of a conversation. These tests are the proof:
// order must not matter, replaying must change nothing, and a fact somebody
// retracted must never come back to life.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Brain } from '../src/engine/brain.js';
import { Cortex } from '../src/engine/cortex.js';
import { applyOps } from '../src/sync/materialize.js';
import { decodeOps, encodeOp, entryId, OPS_VERSION, type Op } from '../src/sync/ops.js';
import { createSpace, joinSpace, prepareShare, commitShare, syncSpaceNow, getIdentity, attachSync } from '../src/sync/space.js';
import { git, gitAvailable } from '../src/sync/git.js';

// Only the knowledge. `created`, `heat` and `access_count` describe how this
// machine has used the memory, not what the team knows, and they are meant to
// differ between people — the sync deliberately leaves them alone.
const huella = (n: any) => createHash('md5').update(JSON.stringify({
  facts: n.facts.map((f: any) => [f.id, f.text, f.status || 'active', f.added]),
  decisions: n.decisions.map((d: any) => [d.id, d.by, d.text, d.rationale]),
  patterns: n.patterns,
  tags: n.tags,
})).digest('hex');

const fact = (nid: string, by: string, text: string, at: string): Op => ({
  v: OPS_VERSION, op: 'fact', nid, by, at, fid: entryId(text), text, conf: 1,
});

describe('merging notes is order-independent', () => {
  const ops: Op[] = [
    { v: OPS_VERSION, op: 'neuron', nid: 'project_x', by: 'ana', at: '2026-08-01T09:00:00Z',
      name: 'Project X', ntype: 'project', domain: 'dev' },
    fact('project_x', 'ana', 'El deploy va por Cloud Run', '2026-08-01T10:00:00Z'),
    fact('project_x', 'bruno', 'El importador tarda 4 minutos', '2026-08-01T11:00:00Z'),
    fact('project_x', 'ana', 'La cache se purga sola', '2026-08-02T09:00:00Z'),
    { v: OPS_VERSION, op: 'status', nid: 'project_x', by: 'bruno', at: '2026-08-03T09:00:00Z',
      fid: entryId('La cache se purga sola'), to: 'retracted', why: 'nunca fue asi' },
    { v: OPS_VERSION, op: 'decision', nid: 'project_x', by: 'ana', at: '2026-08-02T12:00:00Z',
      did: entryId('Publicar en el registro'), text: 'Publicar en el registro', why: 'visibilidad' },
    { v: OPS_VERSION, op: 'pattern', nid: 'project_x', by: 'bruno', at: '2026-08-02T13:00:00Z',
      text: 'Los mu-plugins no se desactivan desde el panel' },
  ];

  it('lands on the same neuron whatever the order', () => {
    const referencia = huella(applyOps(null, ops, { id: 'project_x' }).neuron);

    for (let i = 0; i < 30; i++) {
      const barajado = [...ops].sort(() => Math.random() - 0.5);
      expect(huella(applyOps(null, barajado, { id: 'project_x' }).neuron)).toBe(referencia);
    }
  });

  it('changes nothing when the same notes arrive twice', () => {
    const una = applyOps(null, ops, { id: 'project_x' }).neuron;
    const dos = applyOps(null, [...ops, ...ops, ...ops], { id: 'project_x' }).neuron;
    expect(huella(dos)).toBe(huella(una));
  });

  it('converges no matter how much each person had seen before', () => {
    const completo = huella(applyOps(null, ops, { id: 'project_x' }).neuron);

    // A sync always replays every log it can see, not just the new lines —
    // which is what makes this safe. So the real question is whether someone
    // who had already merged part of the history lands in the same place as
    // someone starting fresh. Whatever they had seen first, they do.
    for (const cuantas of [0, 1, 3, 5, ops.length]) {
      const parcial = [...ops].sort(() => Math.random() - 0.5).slice(0, cuantas);
      const antes = applyOps(null, parcial, { id: 'project_x' }).neuron;
      const despues = applyOps(antes, ops);
      expect(huella(despues.neuron)).toBe(completo);
    }
  });

  it('never brings a retracted fact back to life', () => {
    // Bruno retracts. Ana's machine still has an old note saying it is fine,
    // and her note arrives afterwards.
    const tarde: Op[] = [...ops, fact('project_x', 'ana', 'La cache se purga sola', '2026-08-04T09:00:00Z')];
    const { neuron } = applyOps(null, tarde, { id: 'project_x' });

    const f = neuron.facts.find(x => x.text === 'La cache se purga sola');
    expect(f?.status).toBe('retracted');
  });

  it('keeps both people\'s reasoning for the same decision', () => {
    const mismos: Op[] = [
      { v: OPS_VERSION, op: 'decision', nid: 'p', by: 'ana', at: '2026-08-01T09:00:00Z',
        did: entryId('Usar Postgres'), text: 'Usar Postgres', why: 'por las transacciones' },
      { v: OPS_VERSION, op: 'decision', nid: 'p', by: 'bruno', at: '2026-08-01T10:00:00Z',
        did: entryId('Usar Postgres'), text: 'Usar Postgres', why: 'porque ya lo conocemos' },
    ];
    const { neuron } = applyOps(null, mismos, { id: 'p' });
    expect(neuron.decisions.length).toBe(2);
  });

  it('does not overwrite a name you already had, but reports the difference', () => {
    const mio = applyOps(null, [ops[0]], { id: 'project_x' }).neuron;
    mio.name = 'Proyecto X';

    const { neuron, report } = applyOps(mio, [
      { v: OPS_VERSION, op: 'neuron', nid: 'project_x', by: 'bruno', at: '2026-08-05T09:00:00Z',
        name: 'ProjectX', ntype: 'project', domain: 'dev' },
    ]);
    expect(neuron.name).toBe('Proyecto X');
    expect(report.divergence.some(d => d.field === 'name')).toBe(true);
  });

  it('treats the same sentence written twice as one fact', () => {
    const a = fact('p', 'ana', 'El  deploy   va por Cloud Run ', '2026-08-01T09:00:00Z');
    const b = fact('p', 'bruno', 'El deploy va por Cloud Run', '2026-08-02T09:00:00Z');
    const { neuron } = applyOps(null, [a, b], { id: 'p' });
    expect(neuron.facts.length).toBe(1);
    // And provenance keeps the earlier date, not the one that arrived last.
    expect(neuron.facts[0].added).toBe('2026-08-01T09:00:00Z');
  });
});

describe('a damaged log costs one line, not the file', () => {
  it('skips what it cannot read and keeps the rest', () => {
    const bueno = encodeOp(fact('p', 'ana', 'uno', '2026-08-01T09:00:00Z'));
    const otro = encodeOp(fact('p', 'ana', 'dos', '2026-08-01T10:00:00Z'));
    const roto = '{"v":1,"op":"fact","nid":"p","by":"ana"';   // cut mid-write

    const { ops, skipped } = decodeOps(`${bueno}\n${roto}\n${otro}\n\n`);
    expect(ops.length).toBe(2);
    expect(skipped).toBe(1);
  });

  it('ignores notes from a newer CRBRO instead of half-reading them', () => {
    const futuro = JSON.stringify({ ...fact('p', 'ana', 'x', '2026-08-01T09:00:00Z'), v: 99 });
    const { ops, skipped } = decodeOps(futuro);
    expect(ops.length).toBe(0);
    expect(skipped).toBe(1);
  });
});

// ─── End to end, with a real git repository ──────────────────────

const hayGit = gitAvailable();

describe.skipIf(!hayGit)('two brains, one repository', () => {
  let raiz: string, remoto: string, anaDir: string, brunoDir: string;
  let ana: { brain: Brain; cortex: Cortex };
  let bruno: { brain: Brain; cortex: Cortex };

  const montar = async (dir: string) => {
    const brain = new Brain(dir);
    await brain.initialize();
    const cortex = new Cortex(brain);
    // Same wiring the server does. Without it nothing would be emitted, which
    // is precisely the failure mode this helper exists to prevent.
    attachSync(brain, cortex);
    return { brain, cortex };
  };

  beforeEach(async () => {
    raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-team-'));
    remoto = path.join(raiz, 'remoto.git');
    await fs.mkdir(remoto, { recursive: true });
    git(['init', '--bare', '-b', 'main'], remoto);

    anaDir = path.join(raiz, 'ana');
    brunoDir = path.join(raiz, 'bruno');
    ana = await montar(anaDir);
    bruno = await montar(brunoDir);
  }, 60_000);

  afterEach(async () => {
    await fs.rm(raiz, { recursive: true, force: true });
  });

  it('carries what one learns to the other, and refuses to carry a secret', async () => {
    // Ana records what she knows, including a credential.
    await ana.cortex.learn('Proyecto Equipo', 'fact', 'El deploy va por Cloud Run.');
    await ana.cortex.learn('Proyecto Equipo', 'fact', 'El importador tarda 4 minutos.');
    await ana.cortex.learn('Proyecto Equipo', 'decision', 'Publicar en el registro MCP.', { rationale: 'visibilidad' });

    const creado = await createSpace(ana.brain, 'equipo', remoto, 'ana');
    expect(creado.ok).toBe(true);

    // A credential written straight into the file, as an older version would.
    const n = (await ana.cortex.peek('project_proyecto_equipo'))!;
    n.facts.push({ text: 'clave: AIzaSyC3xK9mP2qR7tV4wX1yZ8aB5cD6eF7gH8i',
                   confidence: 1, added: new Date().toISOString(), source: 'session' });
    await fs.writeFile(ana.brain.paths.neuron(n.id), JSON.stringify(n), 'utf-8');

    // Sharing refuses while it is there.
    const bloqueado = await prepareShare(ana.brain, ana.cortex, n.id, 'equipo');
    expect('error' in bloqueado).toBe(false);
    if (!('error' in bloqueado)) {
      expect(bloqueado.blocked.length).toBeGreaterThan(0);
      expect(bloqueado.confirm_token).toBeUndefined();
    }

    // Remove it and share for real.
    await ana.cortex.forget(n.id, ['clave: AIzaSyC3xK9mP2qR7tV4wX1yZ8aB5cD6eF7gH8i']);
    const listo = await prepareShare(ana.brain, ana.cortex, n.id, 'equipo');
    if ('error' in listo) throw new Error(listo.error);
    expect(listo.blocked).toEqual([]);
    expect(listo.confirm_token).toBeTruthy();

    const compartido = await commitShare(ana.brain, ana.cortex, n.id, 'equipo', listo.confirm_token!);
    expect(compartido.ok).toBe(true);
    await syncSpaceNow(ana.brain, ana.cortex, 'equipo');

    // Bruno joins and pulls.
    const unido = await joinSpace(bruno.brain, 'equipo', remoto, 'bruno');
    expect(unido.ok).toBe(true);
    const traido = await syncSpaceNow(bruno.brain, bruno.cortex, 'equipo');
    expect(traido.state).toBe('ok');

    const suyo = await bruno.cortex.peek(n.id);
    expect(suyo).not.toBeNull();
    const textos = suyo!.facts.map(f => f.text);
    expect(textos).toContain('El deploy va por Cloud Run.');
    expect(textos).toContain('El importador tarda 4 minutos.');
    expect(textos.some(t => t.includes('AIza'))).toBe(false);   // the secret never travelled
    expect(suyo!.decisions.length).toBe(1);
    expect(suyo!.facts[0].source).toContain('team:ana');
  }, 120_000);

  it('merges what both wrote while apart, and honours a retraction', async () => {
    await ana.cortex.learn('Proyecto Equipo', 'fact', 'Punto de partida.');
    await createSpace(ana.brain, 'equipo', remoto, 'ana');
    const prep = await prepareShare(ana.brain, ana.cortex, 'project_proyecto_equipo', 'equipo');
    if ('error' in prep) throw new Error(prep.error);
    await commitShare(ana.brain, ana.cortex, 'project_proyecto_equipo', 'equipo', prep.confirm_token!);
    await syncSpaceNow(ana.brain, ana.cortex, 'equipo');

    await joinSpace(bruno.brain, 'equipo', remoto, 'bruno');
    await syncSpaceNow(bruno.brain, bruno.cortex, 'equipo');

    // Both work without syncing in between.
    await ana.cortex.learn('Proyecto Equipo', 'fact', 'Ana descubre que el cron va a las 5.');
    await bruno.cortex.learn('Proyecto Equipo', 'fact', 'Bruno descubre que el cron va a las 6.');
    await bruno.cortex.revise('project_proyecto_equipo', ['Punto de partida.'],
      { status: 'retracted', note: 'nunca fue asi' });

    await syncSpaceNow(ana.brain, ana.cortex, 'equipo');
    await syncSpaceNow(bruno.brain, bruno.cortex, 'equipo');
    await syncSpaceNow(ana.brain, ana.cortex, 'equipo');

    const deAna = (await ana.cortex.peek('project_proyecto_equipo'))!;
    const deBruno = (await bruno.cortex.peek('project_proyecto_equipo'))!;

    const vivos = (n: typeof deAna) =>
      n.facts.filter(f => f.status !== 'retracted' && f.status !== 'superseded').map(f => f.text).sort();

    expect(vivos(deAna)).toContain('Ana descubre que el cron va a las 5.');
    expect(vivos(deAna)).toContain('Bruno descubre que el cron va a las 6.');
    expect(vivos(deAna)).toEqual(vivos(deBruno));           // both ended up the same
    expect(vivos(deAna)).not.toContain('Punto de partida.'); // the retraction stuck
  }, 120_000);

  it('keeps working with no network and sends the backlog afterwards', async () => {
    await ana.cortex.learn('Proyecto Equipo', 'fact', 'Antes del corte.');
    await createSpace(ana.brain, 'equipo', remoto, 'ana');
    const prep = await prepareShare(ana.brain, ana.cortex, 'project_proyecto_equipo', 'equipo');
    if ('error' in prep) throw new Error(prep.error);
    await commitShare(ana.brain, ana.cortex, 'project_proyecto_equipo', 'equipo', prep.confirm_token!);
    await syncSpaceNow(ana.brain, ana.cortex, 'equipo');

    // The remote disappears: a laptop on a train.
    const escondido = `${remoto}.apagado`;
    await fs.rename(remoto, escondido);

    await ana.cortex.learn('Proyecto Equipo', 'fact', 'Durante el corte, y esto no se pierde.');
    const sinRed = await syncSpaceNow(ana.brain, ana.cortex, 'equipo', 8_000);
    expect(['offline', 'auth']).toContain(sinRed.state);

    // Local memory is untouched — the whole point.
    const local = (await ana.cortex.peek('project_proyecto_equipo'))!;
    expect(local.facts.map(f => f.text)).toContain('Durante el corte, y esto no se pierde.');

    // The network comes back and the backlog goes out.
    await fs.rename(escondido, remoto);
    const vuelta = await syncSpaceNow(ana.brain, ana.cortex, 'equipo');
    expect(vuelta.state).toBe('ok');

    await joinSpace(bruno.brain, 'equipo', remoto, 'bruno');
    await syncSpaceNow(bruno.brain, bruno.cortex, 'equipo');
    const suyo = (await bruno.cortex.peek('project_proyecto_equipo'))!;
    expect(suyo.facts.map(f => f.text)).toContain('Durante el corte, y esto no se pierde.');
  }, 120_000);

  it('never puts the cortex or preferences in the repository', async () => {
    await ana.cortex.learn('Proyecto Equipo', 'fact', 'Un hecho normal.');
    await ana.cortex.learn('Proyecto Equipo', 'preference', 'La API key de ejemplo vive aqui.');
    await createSpace(ana.brain, 'equipo', remoto, 'ana');
    const prep = await prepareShare(ana.brain, ana.cortex, 'project_proyecto_equipo', 'equipo');
    if ('error' in prep) throw new Error(prep.error);
    expect(prep.skipped_preferences).toBe(1);
    await commitShare(ana.brain, ana.cortex, 'project_proyecto_equipo', 'equipo', prep.confirm_token!);
    await syncSpaceNow(ana.brain, ana.cortex, 'equipo');

    const dentro = git(['ls-files'], path.join(ana.brain.paths.shared, 'equipo')).stdout;
    expect(dentro).not.toContain('cortex/');
    expect(dentro).toContain('neurons/project_proyecto_equipo/ops/');

    const logs = await fs.readFile(
      path.join(ana.brain.paths.shared, 'equipo', 'neurons', 'project_proyecto_equipo', 'ops', 'ana.' +
        (await getIdentity(ana.brain)).device + '.jsonl'),
      'utf-8'
    );
    expect(logs).not.toContain('La API key de ejemplo vive aqui');
  }, 120_000);

  it('the share backfill carries errors and map written BEFORE sharing', async () => {
    // Lo aprendido antes de compartir viaja en el backfill de neuronOps.
    // Sin esto, el primer share de una neurona con historia dejaba fuera
    // su mapa y su registro de errores para siempre.
    await ana.cortex.learn('Proyecto Equipo', 'fact', 'Punto de partida.');
    await ana.cortex.setMap('project_proyecto_equipo', 'MAPA: vive en /srv y lo sirve systemd.');
    await ana.cortex.learn('Proyecto Equipo', 'error', 'ERROR: A. CORRECCION: B.');

    await createSpace(ana.brain, 'equipo', remoto, 'ana');
    const prep = await prepareShare(ana.brain, ana.cortex, 'project_proyecto_equipo', 'equipo');
    if ('error' in prep) throw new Error(prep.error);
    await commitShare(ana.brain, ana.cortex, 'project_proyecto_equipo', 'equipo', prep.confirm_token!);
    await syncSpaceNow(ana.brain, ana.cortex, 'equipo');

    await joinSpace(bruno.brain, 'equipo', remoto, 'bruno');
    await syncSpaceNow(bruno.brain, bruno.cortex, 'equipo');

    const suyo = await bruno.cortex.peek('project_proyecto_equipo');
    expect(suyo!.map?.text).toContain('/srv');
    expect(suyo!.errors || []).toHaveLength(1);
  }, 120_000);

  it('a credential hiding in the map blocks the share', async () => {
    await ana.cortex.learn('Proyecto Equipo', 'fact', 'Punto de partida.');
    await createSpace(ana.brain, 'equipo', remoto, 'ana');
    // Directo al fichero, como haria un cliente antiguo o una edicion a mano:
    // el escaner del share tiene que pillarlo aunque la redaccion no corriera.
    const n = (await ana.cortex.peek('project_proyecto_equipo'))!;
    n.map = { text: 'MAPA: el CI usa la clave AIzaSyC3xK9mP2qR7tV4wX1yZ8aB5cD6eF7gH8i para deploy.',
              updated: new Date().toISOString() };
    await fs.writeFile(ana.brain.paths.neuron(n.id), JSON.stringify(n), 'utf-8');

    const prep = await prepareShare(ana.brain, ana.cortex, n.id, 'equipo');
    if ('error' in prep) throw new Error(prep.error);
    expect(prep.blocked.some(b => b.where === 'map')).toBe(true);
    expect(prep.confirm_token).toBeUndefined();
  }, 120_000);

  it('a forgotten error stays forgotten after the next sync', async () => {
    const err = 'ERROR: use la clave en claro. CORRECCION: a la boveda.';
    await ana.cortex.learn('Proyecto Equipo', 'fact', 'Punto de partida.');
    await createSpace(ana.brain, 'equipo', remoto, 'ana');
    const prep = await prepareShare(ana.brain, ana.cortex, 'project_proyecto_equipo', 'equipo');
    if ('error' in prep) throw new Error(prep.error);
    await commitShare(ana.brain, ana.cortex, 'project_proyecto_equipo', 'equipo', prep.confirm_token!);
    await ana.cortex.learn('Proyecto Equipo', 'error', err);   // emitido al log
    await syncSpaceNow(ana.brain, ana.cortex, 'equipo');

    // Ana lo olvida; la purga viaja; el siguiente sync NO lo resucita.
    await ana.cortex.forget('project_proyecto_equipo', [err]);
    await syncSpaceNow(ana.brain, ana.cortex, 'equipo');
    const tras = await ana.cortex.peek('project_proyecto_equipo');
    expect(tras!.errors || []).toHaveLength(0);

    // Y Bruno, que ve el log completo, tampoco lo materializa.
    await joinSpace(bruno.brain, 'equipo', remoto, 'bruno');
    await syncSpaceNow(bruno.brain, bruno.cortex, 'equipo');
    const suyo = await bruno.cortex.peek('project_proyecto_equipo');
    expect(suyo!.errors || []).toHaveLength(0);
  }, 120_000);

  it('carries the system map and the error ledger, and the newest map wins', async () => {
    await ana.cortex.learn('Proyecto Equipo', 'fact', 'Punto de partida.');
    await createSpace(ana.brain, 'equipo', remoto, 'ana');
    const prep = await prepareShare(ana.brain, ana.cortex, 'project_proyecto_equipo', 'equipo');
    if ('error' in prep) throw new Error(prep.error);
    await commitShare(ana.brain, ana.cortex, 'project_proyecto_equipo', 'equipo', prep.confirm_token!);

    // Ana writes the map and an error AFTER sharing, so they emit as ops.
    await ana.cortex.setMap('project_proyecto_equipo',
      'MAPA: la API vive en /srv/api y la sirve systemd; el deploy es git pull + restart.');
    await ana.cortex.learn('Proyecto Equipo', 'error',
      'ERROR: reinicie el servicio sin drenar. CORRECCION: systemctl reload, nunca restart en horario.');
    await syncSpaceNow(ana.brain, ana.cortex, 'equipo');

    await joinSpace(bruno.brain, 'equipo', remoto, 'bruno');
    await syncSpaceNow(bruno.brain, bruno.cortex, 'equipo');

    const suyo = await bruno.cortex.peek('project_proyecto_equipo');
    expect(suyo).not.toBeNull();
    expect(suyo!.map?.text).toContain('/srv/api');
    expect(suyo!.errors || []).toHaveLength(1);
    expect((suyo!.errors || [])[0]).toContain('drenar');

    // Bruno rewrites the map; after a round-trip Ana holds Bruno's version.
    await bruno.cortex.setMap('project_proyecto_equipo',
      'MAPA: la API vive en /srv/api, systemd, y desde agosto el deploy va por CI.');
    await syncSpaceNow(bruno.brain, bruno.cortex, 'equipo');
    await syncSpaceNow(ana.brain, ana.cortex, 'equipo');

    const deAna = await ana.cortex.peek('project_proyecto_equipo');
    expect(deAna!.map?.text).toContain('desde agosto el deploy va por CI');
    expect(deAna!.map?.by).toBe('bruno');
  }, 120_000);
});
