import { it, expect } from 'vitest';
import { entryQuality } from '../src/search/quality.js';
import type { Neuron } from '../src/types/index.js';
const neuron = (fact: any) => ({ facts: [fact] } as Neuron);
const base = { id: 'f1', text: 'El puerto es 8443.', added: '2026-10-01', source: 'session', confidence: 1 };
it('una coincidencia fuerte no convierte un dato sin comprobar en verificado', () => {
  expect(entryQuality(neuron(base), 'f1', 'fact', base.text)).toMatchObject({
    temporal: 'current_claim', verification: { method: 'none' }, freshness: { state: 'unverified' },
  });
});
it('no inventa una fuente para fechas de verificación antiguas', () => {
  expect(entryQuality(neuron({ ...base, verified: '2026-10-02' }), 'f1', 'fact', base.text).verification)
    .toEqual({ method: 'legacy', at: '2026-10-02' });
});
it('un importado es historia, salvo clasificación actual explícita', () => {
  expect(entryQuality(neuron({ ...base, source: 'miner' }), 'f1', 'fact', base.text).temporal).toBe('historical');
  expect(entryQuality(neuron({ ...base, source: 'miner', temporal: 'current' }), 'f1', 'fact', base.text).temporal).toBe('current_claim');
});
it('una fuente comprobada también puede haber caducado después', () => {
  const checked = { method: 'source', at: '2026-01-01', reference: { kind: 'file', value: 'config.json', field: 'port' } };
  const q = entryQuality(neuron({ ...base, verified: checked.at, verification: checked }), 'f1', 'fact', base.text, { stale: true });
  expect(q.verification).toEqual(checked);
  expect(q.freshness.state).toBe('stale');
});
