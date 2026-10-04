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
