// ─── Talking to CRBRO the way a client does ──────────────────────
//
// import and view never touch brain files. They spawn this package's own
// server (dist/index.js) over stdio with the same environment, and speak MCP
// to it like any other client. When the owner runs the daemon, that server is
// a proxy and the daemon stays the single writer; either way every write goes
// through the tools' validation, redaction and de-duplication.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export interface ToolOutcome {
  /** false when the tool flagged isError, or the call itself failed. */
  ok: boolean;
  /** The JSON the tool returned (structuredContent first), or null when it answered in prose. */
  data: any;
  /** The first text block, as sent. */
  text: string;
}

export interface ToolCaller {
  call(name: string, args?: Record<string, unknown>): Promise<ToolOutcome>;
  close(): Promise<void>;
}

/** Where the server entry point is: dist/index.js next to this compiled file, or the package's dist from source. */
export function defaultServerEntry(): string {
  const candidates = [
    path.join(__dirname, '..', 'index.js'),               // dist/cli → dist/index.js
    path.join(__dirname, '..', '..', 'dist', 'index.js'), // src/cli under the test runner
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

/** Wrap a connected MCP client. */
export function callerFromClient(client: Client, onClose?: () => Promise<void>): ToolCaller {
  return {
    async call(name, args = {}) {
      try {
        const r: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
        const text = typeof r?.content?.[0]?.text === 'string' ? r.content[0].text : '';
        let data: any = null;
        if (r?.structuredContent && typeof r.structuredContent === 'object') data = r.structuredContent;
        else {
          try { data = JSON.parse(text); } catch { data = null; }
        }
        return { ok: !r?.isError, data, text };
      } catch (err) {
        return { ok: false, data: null, text: err instanceof Error ? err.message : String(err) };
      }
    },
    async close() {
      try { await client.close(); } catch { /* already closed */ }
      if (onClose) await onClose();
    },
  };
}

/** Connect a client over any transport (tests use an in-memory pair). */
export async function connectCaller(transport: Transport, onClose?: () => Promise<void>): Promise<ToolCaller> {
  const client = new Client({ name: 'crbro-memory-cli', version: '1.0.0' });
  await client.connect(transport);
  return callerFromClient(client, onClose);
}

export interface SpawnOptions {
  /** Server entry point; defaults to this package's dist/index.js. */
  entry?: string;
  /** Environment for the child; defaults to this process's, whole (CRBRO_PATH, HOME, CRBRO_* all travel). */
  env?: NodeJS.ProcessEnv;
}

export interface SpawnedCaller extends ToolCaller {
  /** The last few KB the server wrote to stderr, for an error message. */
  stderrTail(): string;
}

/**
 * Spawn `node dist/index.js` and connect to it. The SDK's default child
 * environment is a short allowlist (PATH, HOME…), which would drop
 * CRBRO_PATH and point the child at another brain: the whole environment is
 * passed on purpose.
 */
export async function spawnServer(opts: SpawnOptions = {}): Promise<SpawnedCaller> {
  const entry = opts.entry ?? defaultServerEntry();
  if (!existsSync(entry)) throw new Error(`CRBRO server not found at ${entry}. Run: npm run build`);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env ?? process.env)) if (typeof v === 'string') env[k] = v;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env,
    stderr: 'pipe',
  });
  let tail = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf8')).slice(-4096);
  });
  let caller: ToolCaller;
  try {
    caller = await connectCaller(transport);
  } catch (err) {
    try { await transport.close(); } catch { /* not started */ }
    const detail = tail.trim() ? `\n${tail.trim()}` : '';
    throw new Error(`could not start the CRBRO server: ${err instanceof Error ? err.message : String(err)}${detail}`);
  }
  return { ...caller, stderrTail: () => tail };
}
