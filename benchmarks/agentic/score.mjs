// Scoring for the agentic benchmark. Pure functions, frozen with tasks.json
// before the first run, and covered by tests/agentic.score.test.ts — a scorer
// that can be tuned after seeing answers is how a benchmark lies.

// \b is ASCII-only in JavaScript: "sé" has no word boundary after the é.
const ABSTAIN = /(?<![\p{L}\p{N}])no[_\s]?lo[_\s]?s[eé](?![\p{L}\p{N}])/iu;

/** correct | stale | abstain | wrong — in that order of precedence, except that a stale value always loses. */
export function scoreAnswer(task, answer) {
  const text = String(answer ?? '').trim();
  if (!text) return 'wrong';
  const has = (src) => new RegExp(src, 'i').test(text);
  if (task.stale && has(task.stale) && !(task.expect && has(task.expect))) return 'stale';
  // Both values in one answer ("was 39, now 49") is correct only if the
  // current one is there; hedging with the old one alone is stale, above.
  if (task.expect === null || task.expect === undefined) return ABSTAIN.test(text) ? 'correct' : 'wrong';
  if (has(task.expect)) return 'correct';
  if (ABSTAIN.test(text)) return 'abstain';
  return 'wrong';
}

/** Per arm and kind: counts of each outcome, plus cost and turns. */
export function aggregate(cells) {
  const out = {};
  for (const c of cells) {
    const arm = (out[c.arm] ||= {});
    const k = (arm[c.kind] ||= { n: 0, correct: 0, stale: 0, abstain: 0, wrong: 0, cost_usd: 0, turns: 0 });
    k.n++;
    k[c.outcome]++;
    k.cost_usd += c.cost_usd || 0;
    k.turns += c.turns || 0;
  }
  return out;
}

/** The four pre-registered thresholds, each with the number it was judged on. */
export function verdict(agg, reps) {
  const pct = (a, b) => (b > 0 ? (100 * a) / b : 0);
  const crbro = agg.crbro || {}, base = agg.baseline || {};
  const z = { n: 0, correct: 0, stale: 0, abstain: 0, wrong: 0 };
  const mem = crbro.memory || z, st = crbro.stale || z;
  const t1 = pct(mem.correct + st.correct, mem.n + st.n);
  const t2 = pct(st.stale, st.n);
  const invented = (k) => pct((k['control-absent'] || z).wrong, (k['control-absent'] || z).n);
  const t4 = Math.min(pct((crbro['control-prompt'] || z).correct, (crbro['control-prompt'] || z).n),
                      pct((base['control-prompt'] || z).correct, (base['control-prompt'] || z).n));
  const checks = [
    { id: 1, rule: 'crbro correct on memory+stale >= 80%', value: +t1.toFixed(1), pass: t1 >= 80 },
    { id: 2, rule: 'crbro stale answers <= 5%', value: +t2.toFixed(1), pass: t2 <= 5 },
    { id: 3, rule: 'crbro invents no more than baseline on control-absent', value: [+invented(crbro).toFixed(1), +invented(base).toFixed(1)], pass: invented(crbro) <= invented(base) },
    { id: 4, rule: 'no arm under 90% on control-prompt', value: +t4.toFixed(1), pass: t4 >= 90 },
  ];
  const enough = reps >= 3;
  return { checks, enough_reps: enough, claim_allowed: enough && checks.every(c => c.pass) };
}
