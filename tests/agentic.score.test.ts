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
import { scoreAnswer, aggregate, verdict } from '../benchmarks/agentic/score.mjs';

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
