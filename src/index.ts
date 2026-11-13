// ─── CRBRO Entry Point ───────────────────────────────────────────
// MCP server via stdio transport — and, since 2.5, two more ways to run:
//
//   (default)   the whole server in this process, speaking MCP on stdio
//   --daemon    the one process that owns the brain for every client (daemon/)
//   daemon on   this process becomes a thin proxy to that daemon
//
// Everything is imported lazily: a proxy must not pay for the search engine
// and the MCP SDK it exists to avoid loading.

async function main() {
  if (process.argv.includes('--daemon')) {
    const { runDaemon } = await import('./daemon/daemon.js');
    await runDaemon();
    return;
  }

  const { resolveBrainDir } = await import('./engine/brain.js');
  const { daemonEnabled, buildId } = await import('./daemon/endpoint.js');
  const { trace, traceStart, TRACE_ON } = await import('./daemon/trace.js');
  const brainRoot = resolveBrainDir();

  if (daemonEnabled(brainRoot)) {
    traceStart(brainRoot, 'proxy');
    const { runProxy, spawnDetachedDaemon } = await import('./daemon/proxy.js');
    const { loadSurface } = await import('./daemon/surface.js');
    const build = buildId();
    // The answers to initialize and tools/list, from the snapshot the build
    // wrote; without one (a bare tsc build) the proxy asks a real server here.
    const surface = loadSurface(build) ?? undefined;
    const proxy = runProxy({
      input: process.stdin,
      output: process.stdout,
      brainRoot,
      build,
      surface,
      spawnDaemon: () => spawnDetachedDaemon(brainRoot),
      isEnabled: () => daemonEnabled(brainRoot),
      log: line => process.stderr.write(`[crbro] ${line}\n`),   // stdout is the MCP wire
      trace,
    });
    await proxy.closed;
    process.exit(0);
  }

  traceStart(brainRoot, 'classic');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { createServer } = await import('./server.js');
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  trace('engine ready', 'server connected (the index loads at crbro_boot)');
  if (TRACE_ON) {
    // Only with the trace on: watch the wire for the two moments that matter.
    const toolCalls = new Set<unknown>();
    const onmessage = transport.onmessage;
    transport.onmessage = (m: any) => {
      if (m?.method === 'tools/call' && m.id !== undefined) toolCalls.add(m.id);
      onmessage?.(m);
    };
    const send = transport.send.bind(transport);
    transport.send = (m: any) => {
      if (m?.result?.serverInfo) trace('initialize answered', 'by the server', true);
      else if (m?.id !== undefined && toolCalls.delete(m.id)) trace('first tool result', '', true);
      return send(m);
    };
  }
}

main().catch((err) => {
  console.error('CRBRO Fatal Error:', err);
  process.exit(1);
});
