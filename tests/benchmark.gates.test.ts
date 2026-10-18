import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { retrievalFailures, securityFailures } from '../benchmarks/gates.mjs';
const baseline = { queries: 48, at1: 37, at3: 40, mrr: 0.806, distractors: 14, confidentDistractors: 2 };
it('el gate hace fallar realmente el proceso de CI', () => {
  const script = `import { enforceGate } from './benchmarks/gates.mjs'; enforceGate(['synthetic regression']);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Quality gate FAILED');
});
it('el gate de recuperación rechaza cada regresión y las métricas ausentes', () => {
  expect(retrievalFailures(baseline)).toEqual([]);
  for (const change of [{ at1: 36 }, { at3: 39 }, { mrr: 0.79 }, { confidentDistractors: 3 }, { queries: 47 }, { mrr: NaN }]) {
    expect(retrievalFailures({ ...baseline, ...change }).length).toBeGreaterThan(0);
  }
});
it('el gate de secretos exige cobertura completa sin falsos positivos', () => {
  expect(securityFailures({ caught: 20, total: 20, falsePositives: 0, innocents: 19 })).toEqual([]);
  expect(securityFailures({ caught: 19, total: 20, falsePositives: 0, innocents: 19 }).length).toBeGreaterThan(0);
  expect(securityFailures({ caught: 20, total: 20, falsePositives: 1, innocents: 19 }).length).toBeGreaterThan(0);
});
