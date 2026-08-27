import { createServer, type Server as HttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler, type McpRequestContext } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { ServerConfig } from '../config/schema.js';
import { createMoneybirdServer, type CreateServerOptions } from './create.js';

/**
 * How incoming HTTP requests are authenticated.
 *
 * - `none`         — no check; only safe when the port is not reachable from outside the host.
 * - `shared-token` — a fixed secret guards the endpoint; the server uses its own Moneybird token.
 * - `passthrough`  — the caller's bearer token *is* the Moneybird token, so one deployment can
 *                    serve many administrations without ever storing a credential.
 */
export type HttpAuthMode = 'none' | 'shared-token' | 'passthrough';

export interface HttpServerOptions extends CreateServerOptions {
  authMode: HttpAuthMode;
  sharedToken?: string | undefined;
  /** Additional path prefix, e.g. `/mcp`. Requests outside it get a 404. */
  endpoint?: string;
  onError?: (error: Error) => void;
}

export interface HttpHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function bearerFrom(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

function unauthorized(detail: string): Response {
  return new Response(JSON.stringify({ error: 'unauthorized', detail }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': 'Bearer realm="moneybird-mcp"',
    },
  });
}

/** Rejects a request that fails the configured authentication, or returns the Moneybird token to use. */
export function authenticate(
  request: Request,
  options: { authMode: HttpAuthMode; sharedToken?: string | undefined },
): { ok: true; token?: string } | { ok: false; response: Response } {
  if (options.authMode === 'none') return { ok: true };

  const presented = bearerFrom(request);
  if (!presented) {
    return { ok: false, response: unauthorized('Missing Authorization: Bearer <token> header.') };
  }

  if (options.authMode === 'shared-token') {
    if (!options.sharedToken || !safeEquals(presented, options.sharedToken)) {
      return { ok: false, response: unauthorized('Invalid token.') };
    }
    return { ok: true };
  }

  return { ok: true, token: presented };
}

/**
 * Serves the MCP server over Streamable HTTP.
 *
 * A fresh server instance is built per request, which keeps the deployment stateless and lets
 * `passthrough` mode bind each request to the credential its caller supplied.
 */
export async function serveHttp(
  options: HttpServerOptions & { config: ServerConfig },
): Promise<HttpHandle> {
  const endpoint = options.endpoint ?? '/mcp';

  const factory = async (context: McpRequestContext) => {
    const perRequestToken =
      options.authMode === 'passthrough' && context.requestInfo
        ? bearerFrom(context.requestInfo)
        : undefined;

    const { server } = await createMoneybirdServer({
      ...options,
      config: perRequestToken ? { ...options.config, apiToken: perRequestToken } : options.config,
    });
    return server;
  };

  const handler = createMcpHandler(factory, {
    ...(options.onError ? { onerror: options.onError } : {}),
  });

  const guarded = {
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      if (url.pathname === '/healthz') {
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname !== endpoint) {
        return new Response('Not found', { status: 404 });
      }

      const auth = authenticate(request, options);
      if (!auth.ok) return auth.response;

      return handler.fetch(request);
    },
  };

  const nodeHandler = toNodeHandler(guarded);
  const httpServer: HttpServer = createServer((request, response) => {
    // Node types `method`/`url` as optional; the SDK handler requires them present, which they
    // always are for a request the server has already routed.
    void nodeHandler(request as Parameters<typeof nodeHandler>[0], response);
  });

  const port = options.config.port;
  const host = options.config.host;

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, resolve);
  });

  const address = httpServer.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    url: `http://${host}:${boundPort}${endpoint}`,
    port: boundPort,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
