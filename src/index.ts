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
  const { daemonEnabled } = await import('./daemon/endpoint.js');
  const brainRoot = resolveBrainDir();

  if (daemonEnabled(brainRoot)) {
    const { runProxy, spawnDetachedDaemon } = await import('./daemon/proxy.js');
    const proxy = runProxy({
      input: process.stdin,
      output: process.stdout,
      brainRoot,
      spawnDaemon: () => spawnDetachedDaemon(brainRoot),
      log: line => process.stderr.write(`[crbro] ${line}\n`),   // stdout is the MCP wire
    });
    await proxy.closed;
    process.exit(0);
  }

  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { createServer } = await import('./server.js');
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('CRBRO Fatal Error:', err);
  process.exit(1);
});
