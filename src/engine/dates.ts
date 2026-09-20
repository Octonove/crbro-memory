// ─── Dates an entry states about itself (2.5) ────────────────────
//
// Patterns, preferences, errors and debts only carry a date since 1.13. On the
// reference brain that left 249 of 457 without one, and recall answered
// `matched_added: ""` for them, so "prefer the more recent" had nothing to
// stand on in exactly the ledgers where it matters.
//
// Most of those entries say when they happened — "Hallazgo (2026-08-30): …",
// "el 14-sep-2026 …". This module reads that and nothing else. The tempting
// fallback, the neuron's `created`, was measured and thrown away: for the
// entries with no date in their text the window between `created` and the day
// dating began had a median of 117 days. A date that loose is not a date, it
// is a guess with a timestamp's authority. What cannot be dated from its own
// words stays undated and is counted as such.
//
// A recovered date is written as a DAY ("2026-08-30"), never an instant.
// `cortex.learn` stamps full ISO instants, so the value itself says how it
// was obtained, the sidecar needs no second field, and every reader — string
// comparison, `new Date()`, the sync `at` — takes it as it is.

const MONTHS: Record<string, number> = {};
const add = (n: number, ...names: string[]) => { for (const s of names) MONTHS[s] = n; };
// Full names and the abbreviations people actually write, es/en/fr/de/it/pt.
// "out" (pt) and "mar"-like collisions are avoided by listing forms, not prefixes.
add(1, 'enero', 'ene', 'january', 'jan', 'janvier', 'janv', 'januar', 'gennaio', 'gen', 'janeiro');
add(2, 'febrero', 'feb', 'february', 'fevrier', 'fev', 'februar', 'febbraio', 'fevereiro');
add(3, 'marzo', 'mar', 'march', 'mars', 'marz', 'maerz', 'marco');
add(4, 'abril', 'abr', 'april', 'apr', 'avril', 'avr', 'aprile');
add(5, 'mayo', 'may', 'mai', 'maggio', 'mag', 'maio');
add(6, 'junio', 'jun', 'june', 'juin', 'juni', 'giugno', 'giu', 'junho');
add(7, 'julio', 'jul', 'july', 'juillet', 'juil', 'juli', 'luglio', 'lug', 'julho');
add(8, 'agosto', 'ago', 'august', 'aug', 'aout', 'aou');
add(9, 'septiembre', 'setiembre', 'sep', 'sept', 'september', 'septembre', 'settembre', 'set', 'setembro');
add(10, 'octubre', 'oct', 'october', 'octobre', 'oktober', 'okt', 'ottobre', 'ott', 'outubro');
add(11, 'noviembre', 'nov', 'november', 'novembre', 'novembro');
add(12, 'diciembre', 'dic', 'december', 'dec', 'decembre', 'dezember', 'dez', 'dicembre', 'dezembro');

const plain = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\.$/, '');

/** "2026-08-30" if y-m-d is a real calendar day, else ''. */
function day(y: number, m: number, d: number): string {
  if (!(y >= 2000 && y <= 2099) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return '';
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export interface TextDate {
  /** Reading as written, or day-first when the numbers allow both. */
  day: string;
  /** The month-first reading of the same digits, when it is a different real day ("04/09/2026"). */
  alt?: string;
}

/**
 * Every calendar date a text states, in order of appearance. Four shapes:
 * 2026-08-30 · 30/08/2026 (or - and .) · 30 de agosto de 2026 / 14-sep-2026 ·
 * August 30, 2026. Two-digit years and bare "en agosto" are not dates.
 */
export function datesInText(text: string): TextDate[] {
  const found: Array<{ at: number } & TextDate> = [];
  let m: RegExpExecArray | null;

  const iso = /(?<![\d\-])(20\d{2})[-/](\d{1,2})[-/](\d{1,2})(?![\d])/g;
  while ((m = iso.exec(text))) {
    const d = day(+m[1], +m[2], +m[3]);
    if (d) found.push({ at: m.index, day: d });
  }

  const numeric = /(?<![\d\-/.])(\d{1,2})([-/.])(\d{1,2})\2(20\d{2})(?![\d])/g;
  while ((m = numeric.exec(text))) {
    const dayFirst = day(+m[4], +m[3], +m[1]);
    const monthFirst = day(+m[4], +m[1], +m[3]);
    if (dayFirst && monthFirst && dayFirst !== monthFirst) found.push({ at: m.index, day: dayFirst, alt: monthFirst });
    else if (dayFirst || monthFirst) found.push({ at: m.index, day: dayFirst || monthFirst });
  }

  const named = /(?<![\d])(\d{1,2})(?:º|\.)?[-\s]+(?:de\s+|of\s+)?([A-Za-zÀ-ÿ]{3,10})\.?,?[-\s]+(?:de\s+|del\s+)?(20\d{2})(?![\d])/g;
  while ((m = named.exec(text))) {
    const mes = MONTHS[plain(m[2])];
    const d = mes ? day(+m[3], mes, +m[1]) : '';
    if (d) found.push({ at: m.index, day: d });
  }

  const english = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})(?![\d])/g;
  while ((m = english.exec(text))) {
    const mes = MONTHS[plain(m[1])];
    const d = mes ? day(+m[3], mes, +m[2]) : '';
    if (d) found.push({ at: m.index, day: d });
  }

  return found.sort((a, b) => a.at - b.at).map(({ day: d, alt }) => (alt ? { day: d, alt } : { day: d }));
}

/**
 * The day an undated entry was written, as far as its own text proves it.
 *
 * An entry cannot predate the latest past day it mentions, and entries are
 * overwhelmingly written the day the thing happened — so the answer is the
 * LATEST stated date inside [floor, ceiling]. `floor` is the neuron's
 * `created`; `ceiling` is the day dating began on this brain (an entry
 * written after that would carry a stamp), or today. Dates outside the window
 * are deadlines, history or typos, not the day of writing. A numeric date
 * that reads both ways counts only if exactly one reading fits the window.
 * '' when the text proves nothing.
 */
export function inferEntryDay(text: string, floor: string, ceiling: string): string {
  const lo = (floor || '').slice(0, 10);
  const hi = (ceiling || '').slice(0, 10);
  const fits = (d: string) => (!lo || d >= lo) && (!hi || d <= hi);
  let best = '';
  for (const f of datesInText(text)) {
    const readings = [f.day, ...(f.alt ? [f.alt] : [])].filter(fits);
    if (readings.length !== 1) continue;
    if (readings[0] > best) best = readings[0];
  }
  return best;
}

/** True for a value written by the backfill (a day), false for a learn() stamp (an instant). */
export function isDayPrecision(value: string | undefined): boolean {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
