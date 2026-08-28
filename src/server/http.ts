import { createServer, type Server as HttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler, type McpRequestContext } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { ServerConfig } from '../config/schema.js';
import type {
  AuthenticatedCaller,
  AuthorizationServer,
} from '../auth/server/authorization-server.js';
import { createMoneybirdServer, type CreateServerOptions } from './create.js';

/**
 * How incoming HTTP requests are authenticated.
 *
 * - `none`         — no check; only safe when the port is not reachable from outside the host.
 * - `shared-token` — a fixed secret guards the endpoint; the server uses its own Moneybird token.
 * - `passthrough`  — the caller's bearer token *is* the Moneybird token, so one deployment can
 *                    serve many administrations without ever storing a credential.
 * - `oauth`        — the server runs an OAuth authorization server in front of Moneybird and
 *                    resolves its own tokens to the credential a user authorized.
 */
export type HttpAuthMode = 'none' | 'shared-token' | 'passthrough' | 'oauth';

export interface HttpServerOptions extends CreateServerOptions {
  authMode: HttpAuthMode;
  sharedToken?: string | undefined;
  /** Required for `oauth`; serves the flow and resolves bearer tokens to Moneybird credentials. */
  authorizationServer?: AuthorizationServer | undefined;
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
 * A fresh MCP server instance is built for each request, which keeps the deployment stateless and
 * lets `passthrough` and `oauth` bind each request to the credential its caller is entitled to.
 */
export async function serveHttp(
  options: HttpServerOptions & { config: ServerConfig },
): Promise<HttpHandle> {
  const endpoint = options.endpoint ?? '/mcp';
  const authorizationServer = options.authorizationServer;

  if (options.authMode === 'oauth' && !authorizationServer) {
    throw new Error('The oauth auth mode requires an authorization server.');
  }

  // The guard resolves the caller once; the factory needs the same answer a moment later and the
  // SDK hands it the very Request object that came in, so identity is enough to carry it across.
  const resolved = new WeakMap<Request, AuthenticatedCaller>();

  const factory = async (context: McpRequestContext) => {
    let perRequest: Partial<ServerConfig> = {};

    if (context.requestInfo) {
      if (options.authMode === 'passthrough') {
        const token = bearerFrom(context.requestInfo);
        if (token) perRequest = { apiToken: token };
      } else if (options.authMode === 'oauth' && authorizationServer) {
        const caller =
          resolved.get(context.requestInfo) ??
          (await (async () => {
            const presented = bearerFrom(context.requestInfo as Request);
            return presented ? await authorizationServer.authenticateBearer(presented) : undefined;
          })());

        if (caller) {
          perRequest = {
            apiToken: caller.token,
            ...(caller.administrationId ? { administrationId: caller.administrationId } : {}),
          };
        }
      }
    }

    const { server } = await createMoneybirdServer({
      ...options,
      config: { ...options.config, ...perRequest },
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

      // Discovery, registration and the flow itself sit outside the MCP endpoint, so they are
      // routed before the endpoint check rejects everything else.
      if (authorizationServer) {
        const handled = await authorizationServer.handle(request);
        if (handled) return handled;
      }

      if (url.pathname !== endpoint) {
        return new Response('Not found', { status: 404 });
      }

      if (options.authMode === 'oauth' && authorizationServer) {
        const presented = bearerFrom(request);
        if (!presented) {
          return authorizationServer.unauthorized('Missing Authorization: Bearer <token> header.');
        }
        const caller = await authorizationServer.authenticateBearer(presented);
        if (!caller) {
          return authorizationServer.unauthorized('Unknown, expired or revoked token.');
        }
        resolved.set(request, caller);
        return handler.fetch(request);
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
