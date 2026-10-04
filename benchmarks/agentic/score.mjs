// Scoring for the agentic benchmark. Pure functions, frozen with tasks.json
// before the first run, and covered by tests/agentic.score.test.ts — a scorer
// that can be tuned after seeing answers is how a benchmark lies.

// \b is ASCII-only in JavaScript: "sé" has no word boundary after the é.
const ABSTAIN = /(?<![\p{L}\p{N}])no[_\s]?lo[_\s]?s[eé](?![\p{L}\p{N}])/iu;

/**
 * The old value given WITH a warning that it may be out of date (amendment of
 * 2026-10-04, stale-unmarked only). Not correct — the current value is one
 * file away — but not the grave failure either, which is asserting the old
 * value as current. Spanish and English, the languages the agent answers in.
 */
const HEDGE = /(posiblemente|quiz[aá]s?|puede que|podr[ií]a (haber|estar|no)|sin verificar|no verificad|sin comprobar|desactualizad|obsolet|antigu|caducad|hace \d+ d[ií]as|seg[uú]n (la )?memoria|[uú]ltimo dato|possibly|may be (out of date|stale|outdated)|might have changed|stale|outdated|unverified|as of)/iu;

/**
 * correct | stale | abstain | wrong — in that order of precedence, except that a stale value always loses.
 * stale-unmarked tasks add `hedged`: the old value, without the current one, but flagged as possibly old.
 */
export function scoreAnswer(task, answer) {
  const text = String(answer ?? '').trim();
  if (!text) return 'wrong';
  const has = (src) => new RegExp(src, 'i').test(text);
  if (task.stale && has(task.stale) && !(task.expect && has(task.expect))) {
    return isUnmarkedKind(task.kind) && HEDGE.test(text) ? 'hedged' : 'stale';
  }
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
    const k = (arm[c.kind] ||= { n: 0, correct: 0, stale: 0, hedged: 0, abstain: 0, wrong: 0, cost_usd: 0, turns: 0 });
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

export const UNMARKED = 'stale-unmarked';
/** Sixth amendment (2026-10-04): the second stale-unmarked case, judged on its own. */
export const UNMARKED_B = 'stale-unmarked-b';

/**
 * Every stale-unmarked kind scores `hedged` the same way: the first case, the
 * second one, and the second one's secondary prompts without the suffix
 * (stale-unmarked-b-free). The original `stale` tasks never do.
 */
export function isUnmarkedKind(kind) {
  return typeof kind === 'string' && (kind === UNMARKED || kind.startsWith(`${UNMARKED}-`));
}

/**
 * The five checks pre-registered for stale-unmarked (amendment of 2026-10-04).
 * `agg` is this run, on the build under test. `before` is the aggregate of a
 * run of the same model and n on the 2.8.0 build — the product without shelf
 * life — and `original` is this run's verdict() when the full task set ran.
 * A check that needs what was not given has pass: null, and null never
 * allows the claim: a missing comparison is not a passed one.
 * `kind` picks the case (sixth amendment): the same five checks, with the
 * same numbers, judge stale-unmarked-b on its own; the rule texts keep the
 * first case's name because the rules are the same.
 */
export function verdictUnmarked(agg, reps, { before = null, original = null, kind = UNMARKED } = {}) {
  const pct = (a, b) => (b > 0 ? (100 * a) / b : 0);
  const z = { n: 0, correct: 0, stale: 0, hedged: 0, abstain: 0, wrong: 0 };
  const cu = (agg.crbro || {})[kind] || z;
  const bu = (agg.baseline || {})[kind] || z;
  const pre = before ? ((before.crbro || {})[kind] || z) : null;
  const u1 = pct(cu.correct, cu.n);
  const u2 = pct(cu.stale, cu.n);
  const checks = [
    { id: 'U1', rule: 'crbro correct on stale-unmarked >= 75%', value: +u1.toFixed(1), pass: cu.n > 0 && u1 >= 75 },
    { id: 'U2', rule: 'crbro gives the old value unflagged in <= 10% of stale-unmarked', value: +u2.toFixed(1), pass: cu.n > 0 && u2 <= 10 },
    { id: 'U3', rule: 'crbro correct >= baseline correct on stale-unmarked', value: [cu.correct, bu.correct], pass: cu.n > 0 && bu.n > 0 && cu.correct >= bu.correct },
    { id: 'U4', rule: 'fewer unflagged old values than the before build (same model, same n)', value: pre ? [cu.stale, pre.stale] : null,
      pass: pre ? (pre.n === cu.n && cu.n > 0 && cu.stale < pre.stale) : null },
    { id: 'U5', rule: 'the four original thresholds still hold in this run', value: original ? original.checks.map(c => c.pass) : null,
      pass: original ? original.checks.every(c => c.pass) : null },
  ];
  const enough = reps >= 3;
  return { kind, checks, enough_reps: enough, claim_allowed: enough && checks.every(c => c.pass === true) };
}
