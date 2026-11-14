// ─── A large semantic pass does not hold recall hostage (2.11) ───
//
// Measured on a copy of a real 563-neuron brain: after the upgrade split long
// entries into parts, ~5,500 passages needed vectors. The pass embedded them
// all and kept them only at the very end, while every recall queued behind it
// (1.5–3 s each, for ~3.5 minutes), and a process that left halfway kept
// nothing. These tests drive SemanticIndex with a fake model: slices land as
// they are made, a query does not wait for the pass, and backfilling() says
// when a pass is running.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SemanticIndex } from '../src/search/semantic.js';

const DIM = 8;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A fake extractor: a deterministic unit vector per text, `delay` ms per call. */
function fakeModel(delay: number, calls: string[]) {
  return async (batch: string[]) => {
    calls.push(...batch);
    await sleep(delay);
    const data = new Float32Array(batch.length * DIM);
    batch.forEach((t, i) => {
      let h = 0;
      for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      for (let d = 0; d < DIM; d++) data[i * DIM + d] = ((h >> d) & 1) ? 1 : -1;
      let n = 0;
      for (let d = 0; d < DIM; d++) n += data[i * DIM + d] ** 2;
      for (let d = 0; d < DIM; d++) data[i * DIM + d] /= Math.sqrt(n);
    });
    return { data };
  };
}

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crbro-backfill-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

function index(delay: number, calls: string[]): SemanticIndex {
  const s = new SemanticIndex(dir);
  (s as any).extractor = fakeModel(delay, calls);
  return s;
}

describe('semantic backfill', () => {
  it('lands vectors slice by slice, and says it is backfilling while it runs', async () => {
    const calls: string[] = [];
    const s = index(1, calls);
    // Timers are coarse on Windows (~15 ms a passage here): 200 passages.
    const entries = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, text: `pasaje número ${i} sobre algo` }));
    const pass = s.upsert(entries);
    let midway = -1;
    let wasBackfilling = false;
    for (let i = 0; i < 2000 && midway < 0; i++) {
      await sleep(5);
      if (s.backfilling()) wasBackfilling = true;
      if (s.count() > 0 && s.count() < 200) midway = s.count();
    }
    expect(midway).toBeGreaterThan(0);             // usable before the pass ends
    expect(wasBackfilling).toBe(true);
    expect(await pass).toBe(200);
    expect(s.count()).toBe(200);
    expect(s.backfilling()).toBe(false);
    // Every id answers a query once the pass is over.
    const hits = await s.query('pasaje número 7 sobre algo', 3);
    expect(hits.length).toBe(3);
  }, 30_000);

  it('a query asked during a pass is answered long before the pass ends', async () => {
    const calls: string[] = [];
    const s = index(4, calls);
    await s.upsert([{ id: 'seed', text: 'semilla' }]);
    // Timers are coarse on Windows (~15 ms): 150 passages make a pass of 1-2 s.
    const entries = Array.from({ length: 150 }, (_, i) => ({ id: `p${i}`, text: `parte ${i}` }));
    const t0 = Date.now();
    let passEnded = 0;
    const pass = s.upsert(entries).then(() => { passEnded = Date.now(); });
    await sleep(60);
    const q0 = Date.now();
    await s.query('una pregunta', 2);
    const queryMs = Date.now() - q0;
    expect(passEnded).toBe(0);                     // the pass is still running
    expect(queryMs).toBeLessThan(250);             // one passage in flight at most, not the whole pass
    await pass;
    expect(passEnded - t0).toBeGreaterThan(queryMs * 3);
  }, 20_000);

  it('a pass waits while a search holds the layer, and goes on when it is released', async () => {
    const calls: string[] = [];
    const s = index(1, calls);
    const release = s.hold();
    const pass = s.upsert(Array.from({ length: 20 }, (_, i) => ({ id: `h${i}`, text: `frase ${i}` })));
    await sleep(80);
    expect(calls).toHaveLength(0);                 // held: not one passage embedded
    release();
    release();                                     // a second release is harmless
    expect(await pass).toBe(20);
    expect(s.count()).toBe(20);
  });

  it('what a pass wrote is there for the next process, which embeds only the rest', async () => {
    const calls: string[] = [];
    const s = index(0, calls);
    const entries = Array.from({ length: 130 }, (_, i) => ({ id: `k${i}`, text: `línea ${i}` }));
    await s.upsert(entries.slice(0, 100));
    await s.persist();
    // Another process: loads the 100, embeds the 30 missing, nothing twice.
    const otherCalls: string[] = [];
    const again = new SemanticIndex(dir);
    await again.load();
    (again as any).extractor = fakeModel(0, otherCalls);
    expect(again.count()).toBe(100);
    expect(await again.upsert(entries)).toBe(30);
    expect(otherCalls).toHaveLength(30);
    expect(again.count()).toBe(130);
    // And it writes back a pair that loads whole.
    await again.persist();
    const third = new SemanticIndex(dir);
    await third.load();
    expect(third.count()).toBe(130);
  });
});
