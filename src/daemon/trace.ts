// ─── CRBRO_STARTUP_TRACE=1: where the start-up time goes ──────────
//
// Until 2.11 "the client says CRBRO is slow to start" could not be broken
// down: not in the client, not in the server. With the variable set, each
// process writes one line per phase — milliseconds since the process started,
// the phase, a detail — to stderr and to <brain>/.daemon/startup-trace.log
// (a detached daemon has no stderr anybody reads). Phases: process start,
// initialize answered, backend connected or in-process fallback, engine
// ready, first tool result.
//
// Off, it costs one boolean test per call site: nothing is formatted, nothing
// is written.

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export const TRACE_ON = (process.env.CRBRO_STARTUP_TRACE || '').trim() === '1';
const LOG_MAX_BYTES = 512 * 1024;

let file: string | null = null;
let role = 'process';
const seen = new Set<string>();

/** Where the log goes and who is writing (proxy, daemon, classic). Writes the "process start" line. */
export function traceStart(brainRoot: string | null, who: string): void {
  if (!TRACE_ON) return;
  role = who;
  if (brainRoot) {
    try {
      const dir = path.join(brainRoot, '.daemon');
      mkdirSync(dir, { recursive: true });
      file = path.join(dir, 'startup-trace.log');
      // Left on for weeks, it keeps one previous file and starts again.
      try { if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`); } catch { /* no log yet */ }
    } catch { file = null; }
  }
  trace('process start', `pid ${process.pid} · started ${new Date(performance.timeOrigin).toISOString()}`);
}

/** One phase. `once`: only the first time this phase is reached in this process. */
export function trace(phase: string, detail = '', once = false): void {
  if (!TRACE_ON) return;
  if (once) { if (seen.has(phase)) return; seen.add(phase); }
  const line = `[crbro trace] ${role} +${performance.now().toFixed(1)}ms ${phase}${detail ? ` · ${detail}` : ''}`;
  try { process.stderr.write(`${line}\n`); } catch { /* no stderr (detached) */ }
  if (file) {
    try { appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${line}\n`); } catch { /* the trace never breaks start-up */ }
  }
}
