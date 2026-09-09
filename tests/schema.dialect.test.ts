import { describe, it, expect } from 'vitest';
import { createServer } from '../src/server.js';

/**
 * The SDK stamps every schema it builds from Zod with draft-07, and a client
 * validating with an Ajv built for 2020-12 — Claude Code — then refuses the
 * tool: «invalid outputSchema: JSON Schema declares an unsupported dialect».
 * It cost recall, inspect and map, which is most of the memory, and it was
 * silent: the server starts fine and the tools simply never arrive.
 *
 * These tests go through the real tools/list handler, not through the source
 * of the schemas, because the label is added during that conversion.
 */
type ListResult = { tools: { name: string; inputSchema?: unknown; outputSchema?: unknown }[] };

async function listTools(): Promise<ListResult> {
  const server = createServer();
  const handlers = (server as unknown as { server: { _requestHandlers: Map<string, unknown> } })
    .server._requestHandlers;
  const handler = handlers.get('tools/list') as (req: unknown, extra: unknown) => Promise<ListResult>;
  return handler({ method: 'tools/list', params: {} }, {});
}

describe('published schemas', () => {
  it('never declare a JSON Schema dialect', async () => {
    const { tools } = await listTools();
    const stamped: string[] = [];
    for (const tool of tools) {
      for (const [key, schema] of Object.entries({ in: tool.inputSchema, out: tool.outputSchema })) {
        if (schema && typeof schema === 'object' && '$schema' in schema) {
          stamped.push(`${tool.name}.${key}Schema = ${String((schema as Record<string, unknown>).$schema)}`);
        }
      }
    }
    expect(stamped).toEqual([]);
  });

  // Guards the fix itself: if the SDK moves its internals the interceptor
  // silently gives up, and this is what would notice.
  it('still ship every tool, with the read tools keeping their output shape', async () => {
    const { tools } = await listTools();
    expect(tools.length).toBeGreaterThan(0);
    const withOutput = tools.filter(t => t.outputSchema).map(t => t.name);
    expect(withOutput).toEqual(expect.arrayContaining(['crbro_recall', 'crbro_inspect']));
    for (const tool of tools) {
      expect(tool.inputSchema, `${tool.name} lost its inputSchema`).toBeTruthy();
    }
  });
});
