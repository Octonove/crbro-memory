// ─── Newline-delimited JSON over a stream ─────────────────────────
//
// The same framing MCP uses on stdio, so a proxy can hand a client's bytes to
// the daemon without understanding them. One JSON value per line, UTF-8.

import type { Socket } from 'node:net';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** A line bigger than this is not a message, it is a mistake or an attack. */
export const MAX_LINE_BYTES = 32 * 1024 * 1024;

/** Splits a byte stream into lines. Tolerates \r\n and lines split across chunks. */
export class LineReader {
  private buf: Buffer[] = [];
  private size = 0;

  constructor(private onLine: (line: string) => void, private onOverflow: () => void) {}

  push(chunk: Buffer): void {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0x0a) continue;
      const piece = chunk.subarray(start, i);
      const whole = this.buf.length ? Buffer.concat([...this.buf, piece]) : piece;
      this.buf = [];
      this.size = 0;
      start = i + 1;
      const line = whole.toString('utf8').replace(/\r$/, '');
      if (line) this.onLine(line);
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      this.buf.push(rest);
      this.size += rest.length;
      if (this.size > MAX_LINE_BYTES) { this.buf = []; this.size = 0; this.onOverflow(); }
    }
  }
}

/**
 * The daemon's side of one client: an MCP Transport over a socket that has
 * already passed the handshake. `scope` wraps every incoming message, which
 * is how per-connection state (the session tally) follows the request through
 * shared engines without any of them knowing about connections.
 */
export class SocketServerTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private closed = false;
  /** Lines that arrived before the server finished connecting, in order. */
  private pending: string[] | null = [];

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
    this.scope(() => this.onmessage?.(message));
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || this.socket.destroyed) return;
    await new Promise<void>(resolve => {
      this.socket.write(`${JSON.stringify(message)}\n`, () => resolve());
    });
  }

  async close(): Promise<void> {
    if (!this.socket.destroyed) this.socket.end();
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
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
