// ─── Newline-delimited JSON over a stream ─────────────────────────
//
// The same framing MCP uses on stdio, so a proxy can hand a client's bytes to
// the daemon without understanding them. One JSON value per line, UTF-8.

import type { Socket } from 'node:net';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** A line bigger than this is not a message, it is a mistake or an attack. */
export const MAX_LINE_BYTES = 32 * 1024 * 1024;
/** How much of an over-long line is kept to say which request it was. */
const HEAD_BYTES = 64 * 1024;

/**
 * Splits a byte stream into lines. Tolerates \r\n and lines split across chunks.
 *
 * A line longer than the limit is reported once, with its first bytes (enough
 * to find its id), and everything up to its newline is thrown away. It used to
 * be cut at the limit and its tail delivered as a line of its own: a broken
 * message, and an id that never got an answer.
 */
export class LineReader {
  private buf: Buffer[] = [];
  private size = 0;
  private discarding = false;

  constructor(
    private onLine: (line: string) => void,
    private onOverflow: (head: string) => void,
    private maxBytes: number = MAX_LINE_BYTES,
  ) {}

  private overflow(piece: Buffer): void {
    const parts = [...this.buf, piece];
    const head = Buffer.concat(parts).subarray(0, HEAD_BYTES).toString('utf8');
    this.buf = [];
    this.size = 0;
    this.onOverflow(head);
  }

  push(chunk: Buffer): void {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0x0a) continue;
      const piece = chunk.subarray(start, i);
      start = i + 1;
      if (this.discarding) { this.discarding = false; continue; }   // the end of a line already refused
      if (this.size + piece.length > this.maxBytes) { this.overflow(piece); continue; }
      const whole = this.buf.length ? Buffer.concat([...this.buf, piece]) : piece;
      this.buf = [];
      this.size = 0;
      const line = whole.toString('utf8').replace(/\r$/, '');
      if (line) this.onLine(line);
    }
    if (start < chunk.length && !this.discarding) {
      const rest = chunk.subarray(start);
      if (this.size + rest.length > this.maxBytes) {
        this.overflow(rest);
        this.discarding = true;   // until the next newline, nothing is a line
        return;
      }
      this.buf.push(rest);
      this.size += rest.length;
    }
  }
}

/** The id of a request, read from the first bytes of a line too long to parse. Null when it cannot be told. */
export function idFromHead(head: string): string | number | null {
  const m = /"id"\s*:\s*("(?:[^"\\]|\\.){0,256}"|-?\d{1,16})/.exec(head);
  if (!m) return null;
  try { return JSON.parse(m[1]) as string | number; } catch { return null; }
}

type Id = string | number;
const isRequest = (m: any): boolean => !!m && typeof m.method === 'string' && m.id !== undefined && m.id !== null;
const isResponse = (m: any): boolean => !!m && m.method === undefined && m.id !== undefined && m.id !== null;

/** The error a stopping daemon gives a request it never started. The proxy recognises it and sends the request again elsewhere. */
export const NOT_STARTED = 'not-started';

/**
 * The daemon's side of one client: an MCP Transport over a socket that has
 * already passed the handshake. `scope` wraps every incoming message, which
 * is how per-connection state (the session tally) follows the request through
 * shared engines without any of them knowing about connections.
 *
 * It counts the requests it has handed to the server and not yet answered, so
 * a daemon that is asked to stop can wait for them instead of cutting a write
 * in half — and, while it waits, refuse new ones in a way the proxy can retry.
 */
export class SocketServerTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private closed = false;
  /** Lines that arrived before the server finished connecting, in order. */
  private pending: string[] | null = [];
  private inflight = new Set<Id>();
  private draining = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private socket: Socket, private scope: <T>(fn: () => T) => T) {}

  /** The server is connected: deliver what waited, in the order it came, and stop queueing. */
  open(): void {
    const waiting = this.pending || [];
    this.pending = null;
    for (const line of waiting) this.receive(line);
  }

  async start(): Promise<void> {
    this.socket.on('close', () => this.finish());
    this.socket.on('error', err => { this.onerror?.(err); this.finish(); });
  }

  /** Requests handed to the server and not answered yet. */
  inFlight(): number {
    return this.inflight.size;
  }

  /** From now on new requests are refused (NOT_STARTED); resolves once those already running are answered. */
  drain(): Promise<void> {
    this.draining = true;
    if (this.inflight.size === 0 || this.closed) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  /** Fed by the daemon, which owns the reader (the handshake used it first). */
  receive(line: string): void {
    if (this.pending) { this.pending.push(line); return; }
    let message: JSONRPCMessage;
    try {
      message = JSON.parse(line) as JSONRPCMessage;
    } catch (err) {
      this.onerror?.(err as Error);
      return;
    }
    if (isRequest(message)) {
      const id = (message as { id: Id }).id;
      if (this.draining) {
        this.write({ jsonrpc: '2.0', id, error: { code: -32000, message: 'CRBRO is restarting: this call was not started.', data: { crbro: NOT_STARTED } } } as JSONRPCMessage);
        return;
      }
      this.inflight.add(id);
    } else if ((message as any).method === 'notifications/cancelled') {
      // A cancelled request is never answered: it is not running any more either.
      if (this.inflight.delete((message as any).params?.requestId)) queueMicrotask(() => this.settle());
    }
    this.scope(() => this.onmessage?.(message));
  }

  private write(message: JSONRPCMessage): Promise<void> {
    if (this.closed || this.socket.destroyed) return Promise.resolve();
    return new Promise<void>(resolve => {
      this.socket.write(`${JSON.stringify(message)}\n`, () => resolve());
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    await this.write(message);
    if (isResponse(message) && this.inflight.delete((message as { id: Id }).id)) this.settle();
  }

  private settle(): void {
    if (this.inflight.size > 0 && !this.closed) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  async close(): Promise<void> {
    if (!this.socket.destroyed) this.socket.end();
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.settle();
    this.onclose?.();
  }
}

/**
 * An in-process backend for the proxy's fallback: the same line interface as
 * a socket, connected to a server living in this process.
 */
export class LoopbackTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  constructor(private deliver: (line: string) => void) {}

  async start(): Promise<void> { /* nothing to open */ }

  receive(line: string): void {
    try {
      this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
    } catch (err) {
      this.onerror?.(err as Error);
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.deliver(JSON.stringify(message));
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}
