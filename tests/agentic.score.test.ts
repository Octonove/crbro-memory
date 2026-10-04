// ─── The agentic benchmark's scorer (2.5) ────────────────────────
//
// The benchmark itself needs a real agent and is not part of this suite. Its
// scorer is: a scorer nobody tests is one that can be bent after the answers
// are in, and the wrong-value rate is the number a memory must not fudge.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs, no types on purpose
import { scoreAnswer, aggregate, verdict, verdictUnmarked } from '../benchmarks/agentic/score.mjs';

const spec = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'benchmarks', 'agentic', 'tasks.json'), 'utf8'));
const task = (id: string) => spec.tasks.find((t: any) => t.id === id);

describe('scoreAnswer', () => {
  it('takes the right value however it is dressed', () => {
    expect(scoreAnswer(task('m1'), '8443')).toBe('correct');
    expect(scoreAnswer(task('m3'), 'Se llama Noelia  Urrutia.')).toBe('correct');
    expect(scoreAnswer(task('m4'), '1.450 €')).toBe('correct');
    expect(scoreAnswer(task('m4'), '1450 euros')).toBe('correct');
  });

  it('a retired value is stale, never "close"', () => {
    expect(scoreAnswer(task('s1'), 'Hetzner')).toBe('stale');
    expect(scoreAnswer(task('s3'), '39 euros al mes')).toBe('stale');
    expect(scoreAnswer(task('s2'), 'Node 22')).toBe('correct');
    // Naming both is correct only because the current one is there.
    expect(scoreAnswer(task('s3'), 'Antes 39, ahora 49 euros')).toBe('correct');
  });

  it('abstaining is its own outcome, and the right one when nothing is stored', () => {
    expect(scoreAnswer(task('m2'), 'NO_LO_SE')).toBe('abstain');
    expect(scoreAnswer(task('a1'), 'NO_LO_SE')).toBe('correct');
    expect(scoreAnswer(task('a1'), 'no lo sé')).toBe('correct');
    expect(scoreAnswer(task('a2'), 'La contraseña es Albatros2026')).toBe('wrong');
  });

  it('anything else is wrong, the empty answer included', () => {
    expect(scoreAnswer(task('m1'), '3000')).toBe('wrong');
    expect(scoreAnswer(task('m1'), '')).toBe('wrong');
    expect(scoreAnswer(task('m1'), '18443')).toBe('wrong');
  });

  it('every frozen task has a well-formed pattern, and stale tasks name their trap', () => {
    for (const t of spec.tasks) {
      if (t.expect !== null) expect(() => new RegExp(t.expect, 'i'), t.id).not.toThrow();
      if (t.kind === 'stale') expect(t.stale, t.id).toBeTruthy();
      if (t.kind === 'control-absent') expect(t.expect, t.id).toBeNull();
    }
    expect(spec.seed.filter((s: any) => s.retired_by)).toHaveLength(spec.tasks.filter((t: any) => t.kind === 'stale').length);
  });
});

describe('verdict', () => {
  const cell = (arm: string, kind: string, outcome: string) => ({ arm, kind, outcome, cost_usd: 0.001, turns: 2 });
  const fill = (arm: string, kind: string, outcomes: string[]) => outcomes.map(o => cell(arm, kind, o));

  it('allows the claim only when all four thresholds hold with n >= 3', () => {
    const cells = [
      ...fill('crbro', 'memory', Array(12).fill('correct')), ...fill('crbro', 'stale', Array(12).fill('correct')),
      ...fill('crbro', 'control-prompt', Array(6).fill('correct')), ...fill('crbro', 'control-absent', Array(6).fill('correct')),
      ...fill('baseline', 'memory', Array(12).fill('abstain')), ...fill('baseline', 'stale', Array(12).fill('abstain')),
      ...fill('baseline', 'control-prompt', Array(6).fill('correct')), ...fill('baseline', 'control-absent', Array(6).fill('correct')),
    ];
    expect(verdict(aggregate(cells), 3).claim_allowed).toBe(true);
    expect(verdict(aggregate(cells), 1).claim_allowed).toBe(false);      // one repetition proves nothing
  });

  it('one stale answer in twelve is already over the line', () => {
    const cells = [
      ...fill('crbro', 'memory', Array(12).fill('correct')), ...fill('crbro', 'stale', [...Array(11).fill('correct'), 'stale']),
      ...fill('crbro', 'control-prompt', Array(6).fill('correct')), ...fill('crbro', 'control-absent', Array(6).fill('correct')),
      ...fill('baseline', 'control-prompt', Array(6).fill('correct')), ...fill('baseline', 'control-absent', Array(6).fill('correct')),
    ];
    const v = verdict(aggregate(cells), 3);
    expect(v.checks.find((c: any) => c.id === 2).pass).toBe(false);
    expect(v.claim_allowed).toBe(false);
  });

  it('a memory that makes the agent invent more than the bare agent fails, whatever else it wins', () => {
    const cells = [
      ...fill('crbro', 'memory', Array(12).fill('correct')), ...fill('crbro', 'stale', Array(12).fill('correct')),
      ...fill('crbro', 'control-prompt', Array(6).fill('correct')), ...fill('crbro', 'control-absent', [...Array(5).fill('correct'), 'wrong']),
      ...fill('baseline', 'control-prompt', Array(6).fill('correct')), ...fill('baseline', 'control-absent', Array(6).fill('correct')),
    ];
    expect(verdict(aggregate(cells), 3).checks.find((c: any) => c.id === 3).pass).toBe(false);
  });
});

// ─── stale-unmarked (amendment of 2026-10-04, pre-registered) ────
// A value that changed in the world and nobody retired. The scorer adds one
// outcome for these tasks only — the old value flagged as possibly old — and
// a verdict of its own; the twelve original tasks score exactly as before.

describe('stale-unmarked', () => {
  it('is pre-registered as four fictitious tasks, each naming its trap, with a world that holds only the current value', () => {
    const tasks = spec.tasks.filter((t: any) => t.kind === 'stale-unmarked');
    expect(tasks.map((t: any) => t.id)).toEqual(['u1', 'u2', 'u3', 'u4']);
    const world = Object.values(spec.unmarked.world).join('\n');
    for (const t of tasks) {
      expect(t.stale, t.id).toBeTruthy();
      expect(new RegExp(t.expect, 'i').test(world), `${t.id}: current value in the world`).toBe(true);
      expect(new RegExp(t.stale, 'i').test(world), `${t.id}: old value absent from the world`).toBe(false);
    }
    // Every task's old value is a live, aged seed fact, and the two halves of
    // the design hold: two marked volatile, two left to the content default,
    // all past the volatile window (90) and inside the normal one (365).
    const aged = spec.unmarked.seed.filter((s: any) => s.age_days > 0);
    expect(aged).toHaveLength(4);
    for (const t of tasks) expect(aged.some((s: any) => new RegExp(t.stale, 'i').test(s.text)), t.id).toBe(true);
    expect(aged.filter((s: any) => s.shelf_life === 'volatile')).toHaveLength(2);
    for (const s of aged) expect(s.age_days > 90 && s.age_days < 365, s.text).toBe(true);
    // No retired_by here: nobody retired these, that is the case.
    expect(spec.unmarked.seed.some((s: any) => s.retired_by)).toBe(false);
  });

  it('the current value is correct, the old value alone is the grave failure, the old value flagged is hedged', () => {
    expect(scoreAnswer(task('u1'), 'PostgreSQL 17')).toBe('correct');
    expect(scoreAnswer(task('u1'), 'PostgreSQL 14')).toBe('stale');
    expect(scoreAnswer(task('u1'), 'PostgreSQL 14 (dato de hace 200 días, sin verificar)')).toBe('hedged');
    expect(scoreAnswer(task('u1'), 'Antes 14, ahora 17')).toBe('correct');
    expect(scoreAnswer(task('u2'), '35 euros al mes')).toBe('correct');
    expect(scoreAnswer(task('u2'), '29 euros')).toBe('stale');
    expect(scoreAnswer(task('u3'), '9443')).toBe('correct');
    expect(scoreAnswer(task('u3'), '9090, possibly outdated')).toBe('hedged');
    expect(scoreAnswer(task('u4'), 'Marcos Elizalde')).toBe('correct');
    expect(scoreAnswer(task('u4'), 'Irene Zubiaurre')).toBe('stale');
    expect(scoreAnswer(task('u4'), 'NO_LO_SE')).toBe('abstain');
  });

  it('a hedge does not soften a retired value in the original stale tasks', () => {
    expect(scoreAnswer(task('s3'), '39 euros, posiblemente desactualizado')).toBe('stale');
  });

  const cell = (arm: string, outcome: string) => ({ arm, kind: 'stale-unmarked', outcome, cost_usd: 0.001, turns: 3 });
  const fill = (arm: string, outcomes: string[]) => outcomes.map(o => cell(arm, o));
  const original = { checks: [1, 2, 3, 4].map(id => ({ id, pass: true })), claim_allowed: true };

  it('allows the claim only with all five checks, n >= 3, a before run and a full run', () => {
    const after = aggregate([...fill('crbro', [...Array(11).fill('correct'), 'hedged']), ...fill('baseline', Array(12).fill('abstain'))]);
    const before = aggregate(fill('crbro', [...Array(6).fill('stale'), ...Array(6).fill('correct')]));
    expect(verdictUnmarked(after, 3, { before, original }).claim_allowed).toBe(true);
    expect(verdictUnmarked(after, 1, { before, original }).claim_allowed).toBe(false);
    // A missing comparison is not a passed one.
    const sinAntes = verdictUnmarked(after, 3, { original });
    expect(sinAntes.checks.find((c: any) => c.id === 'U4').pass).toBeNull();
    expect(sinAntes.claim_allowed).toBe(false);
    expect(verdictUnmarked(after, 3, { before }).claim_allowed).toBe(false);
  });

  it('two unflagged old values in twelve fail U2; a before run with none leaves nothing to improve (U4)', () => {
    const after = aggregate([...fill('crbro', [...Array(10).fill('correct'), 'stale', 'stale']), ...fill('baseline', Array(12).fill('abstain'))]);
    expect(verdictUnmarked(after, 3, {}).checks.find((c: any) => c.id === 'U2').pass).toBe(false);
    const clean = aggregate([...fill('crbro', Array(12).fill('correct')), ...fill('baseline', Array(12).fill('abstain'))]);
    const before = aggregate(fill('crbro', Array(12).fill('correct')));
    expect(verdictUnmarked(clean, 3, { before, original }).checks.find((c: any) => c.id === 'U4').pass).toBe(false);
  });

  it('a memory that answers worse than no memory fails U3, and a regression on the original four fails U5', () => {
    const after = aggregate([...fill('crbro', [...Array(9).fill('correct'), ...Array(3).fill('hedged')]), ...fill('baseline', Array(12).fill('correct'))]);
    expect(verdictUnmarked(after, 3, {}).checks.find((c: any) => c.id === 'U3').pass).toBe(false);
    const roto = { checks: [{ id: 1, pass: true }, { id: 2, pass: false }, { id: 3, pass: true }, { id: 4, pass: true }] };
    expect(verdictUnmarked(after, 3, { original: roto }).checks.find((c: any) => c.id === 'U5').pass).toBe(false);
  });
});

// ─── stale-unmarked-b (sixth amendment, 2026-10-04, pre-registered) ────
// A second case on a new project, written without reading the detector: the
// same five checks judge it on its own; two prompts without the suffix and
// two old-but-true controls are secondary.

describe('stale-unmarked-b', () => {
  const b = spec.unmarked_b;
  const world = Object.values(b.world).join('\n');
  const main = spec.tasks.filter((t: any) => t.kind === 'stale-unmarked-b');
  const free = spec.tasks.filter((t: any) => t.kind === 'stale-unmarked-b-free');
  const controls = spec.tasks.filter((t: any) => t.kind === 'old-true-b');
  const aged = b.seed.filter((s: any) => s.age_days > 0);

  it('is pre-registered as six tasks on a world that holds only the current value, each old value a live aged fact', () => {
    expect(main.map((t: any) => t.id)).toEqual(['w1', 'w2', 'w3', 'w4', 'w5', 'w6']);
    expect(b.kinds).toEqual(['stale-unmarked-b', 'stale-unmarked-b-free', 'old-true-b']);
    for (const t of [...main, ...free]) {
      expect(t.stale, t.id).toBeTruthy();
      expect(new RegExp(t.expect, 'i').test(world), `${t.id}: current value in the world`).toBe(true);
      expect(new RegExp(t.stale, 'i').test(world), `${t.id}: old value absent from the world`).toBe(false);
      const fact = aged.find((s: any) => new RegExp(t.stale, 'i').test(s.text));
      expect(fact, `${t.id}: old value is an aged seed fact`).toBeTruthy();
      expect(new RegExp(t.expect, 'i').test(fact.text), `${t.id}: the old fact does not hold the new value`).toBe(false);
    }
    // The mix the amendment names: two volatile, one normal, three unmarked
    // among w1-w6; ages past 90 and under 365, and not all the same.
    const forMain = main.map((t: any) => aged.find((s: any) => new RegExp(t.stale, 'i').test(s.text)));
    expect(forMain.filter((s: any) => s.shelf_life === 'volatile')).toHaveLength(2);
    expect(forMain.filter((s: any) => s.shelf_life === 'normal')).toHaveLength(1);
    expect(forMain.filter((s: any) => !s.shelf_life)).toHaveLength(3);
    for (const s of aged) expect(s.age_days > 90 && s.age_days < 365, s.text).toBe(true);
    expect(new Set(aged.map((s: any) => s.age_days)).size).toBeGreaterThan(1);
    expect(b.seed.some((s: any) => s.retired_by)).toBe(false);
    // Nothing of the first case leaks into the second, and no task id repeats.
    expect(world).not.toMatch(/pel[ií]cano/i);
    const ids = spec.tasks.map((t: any) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the free prompts repeat w2 and w3 word for word, without the suffix; nothing else drops it', () => {
    expect(free.map((t: any) => t.id)).toEqual(['w2f', 'w3f']);
    for (const t of free) {
      const twin = main.find((m: any) => m.id === t.id.slice(0, -1));
      expect(t.suffix).toBe(false);
      expect([t.prompt, t.expect, t.stale]).toEqual([twin.prompt, twin.expect, twin.stale]);
    }
    expect(spec.tasks.filter((t: any) => t.suffix === false).every((t: any) => t.kind === 'stale-unmarked-b-free')).toBe(true);
  });

  it('the controls are old facts that still hold: the same value in memory and in the world', () => {
    expect(controls.map((t: any) => t.id)).toEqual(['k1', 'k2']);
    for (const t of controls) {
      expect(t.stale, t.id).toBeUndefined();
      expect(new RegExp(t.expect, 'i').test(world), t.id).toBe(true);
      expect(aged.some((s: any) => new RegExp(t.expect, 'i').test(s.text)), t.id).toBe(true);
    }
  });

  it('scores the second case like the first: current is correct, old alone is stale, old flagged is hedged', () => {
    expect(scoreAnswer(task('w1'), 'MessageBird')).toBe('correct');
    expect(scoreAnswer(task('w1'), 'Twilio')).toBe('stale');
    expect(scoreAnswer(task('w2'), '265 euros')).toBe('correct');
    expect(scoreAnswer(task('w2'), '240 euros (dato de hace 160 días, sin verificar)')).toBe('hedged');
    expect(scoreAnswer(task('w2f'), 'Según la memoria eran 240 €, pero tarifas.csv dice 265 €.')).toBe('correct');
    expect(scoreAnswer(task('w3'), 'Jon Ander Sarasola')).toBe('correct');
    expect(scoreAnswer(task('w3'), 'Olatz Iturbe')).toBe('stale');
    expect(scoreAnswer(task('w4'), 'reservas.tramuntana.cat')).toBe('correct');
    expect(scoreAnswer(task('w4'), 'https://reservas.tramuntana.cat/api')).toBe('correct');
    expect(scoreAnswer(task('w4'), 'api.tramuntana.cat')).toBe('stale');
    expect(scoreAnswer(task('w5'), '09:30')).toBe('correct');
    expect(scoreAnswer(task('w5'), 'A las 9.30')).toBe('correct');
    expect(scoreAnswer(task('w5'), '10:00')).toBe('stale');
    expect(scoreAnswer(task('w5'), 'A las 10 h')).toBe('stale');
    expect(scoreAnswer(task('w5'), '16:00')).toBe('wrong');
    expect(scoreAnswer(task('w6'), '24 horas')).toBe('correct');
    expect(scoreAnswer(task('w6'), '48')).toBe('stale');
    expect(scoreAnswer(task('k1'), 'Redsys')).toBe('correct');
    expect(scoreAnswer(task('k2'), '55 euros')).toBe('correct');
    expect(scoreAnswer(task('k2'), 'NO_LO_SE')).toBe('abstain');
  });

  it('the same five checks judge it on its own kind, and the first case does not count for it', () => {
    const cellB = (arm: string, outcome: string) => ({ arm, kind: 'stale-unmarked-b', outcome, cost_usd: 0.001, turns: 3 });
    const original = { checks: [1, 2, 3, 4].map(id => ({ id, pass: true })), claim_allowed: true };
    const after = aggregate([...Array(17).fill('correct'), 'stale'].map(o => cellB('crbro', o)).concat(Array(18).fill('abstain').map(o => cellB('baseline', o))));
    const before = aggregate(Array(18).fill('stale').map(o => cellB('crbro', o)));
    const v = verdictUnmarked(after, 3, { before, original, kind: 'stale-unmarked-b' });
    expect(v.kind).toBe('stale-unmarked-b');
    expect(v.claim_allowed).toBe(true);
    // Two unflagged old values in eighteen is over the 10 % line.
    const two = aggregate([...Array(16).fill('correct'), 'stale', 'stale'].map(o => cellB('crbro', o)));
    expect(verdictUnmarked(two, 3, { before, original, kind: 'stale-unmarked-b' }).checks.find((c: any) => c.id === 'U2').pass).toBe(false);
    // Read as the first case, this run has nothing: U1 cannot pass on zero cells.
    expect(verdictUnmarked(after, 3, { before, original }).checks.find((c: any) => c.id === 'U1').pass).toBe(false);
  });
});
