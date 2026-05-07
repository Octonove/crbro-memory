// ─── CRBRO Entry Point ───────────────────────────────────────────
// MCP server via stdio transport

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('CRBRO Fatal Error:', err);
  process.exit(1);
});
