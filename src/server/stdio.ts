import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createMoneybirdServer, type CreateServerOptions } from './create.js';

export interface StdioHandle {
  close(): Promise<void>;
  toolCount: number;
}

/**
 * Serves the MCP server over stdio.
 *
 * stdout carries the JSON-RPC stream, so every diagnostic must go to stderr — a stray
 * `console.log` anywhere in the process corrupts the protocol.
 */
export async function serveStdio(options: CreateServerOptions): Promise<StdioHandle> {
  const { server, registration } = await createMoneybirdServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  return {
    toolCount: registration.registered.length,
    close: () => server.close(),
  };
}
