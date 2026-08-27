import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * A one-shot loopback listener for the OAuth redirect (RFC 8252 §7.3).
 *
 * Moneybird requires the redirect URI to match the registered one exactly, including the port,
 * so the caller must register `http://127.0.0.1:<port>/callback` and pass that same port here.
 */
export interface LoopbackResult {
  code: string;
  state: string | undefined;
}

export interface LoopbackOptions {
  port: number;
  host?: string;
  path?: string;
  /** Rejected with a timeout error when the user never completes the browser flow. */
  timeoutMs?: number;
  expectedState?: string | undefined;
}

export class LoopbackServer {
  private readonly server: Server;
  private readonly path: string;
  private readonly expectedState: string | undefined;
  private settle: ((result: LoopbackResult) => void) | undefined;
  private fail: ((error: Error) => void) | undefined;

  constructor(private readonly options: LoopbackOptions) {
    this.path = options.path ?? '/callback';
    this.expectedState = options.expectedState;
    this.server = createServer((request, response) => this.handle(request.url ?? '', response));
  }

  get redirectUri(): string {
    const address = this.server.address() as AddressInfo | null;
    const port = address?.port ?? this.options.port;
    return `http://${this.options.host ?? '127.0.0.1'}:${port}${this.path}`;
  }

  /** Starts listening and resolves with the authorization code the browser delivers. */
  async waitForCode(): Promise<LoopbackResult> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.port, this.options.host ?? '127.0.0.1', resolve);
    });

    const timeoutMs = this.options.timeoutMs ?? 5 * 60 * 1000;
    try {
      return await new Promise<LoopbackResult>((resolve, reject) => {
        this.settle = resolve;
        this.fail = reject;
        const timer = setTimeout(() => {
          reject(
            new Error(`No authorization code received within ${Math.round(timeoutMs / 1000)}s`),
          );
        }, timeoutMs);
        timer.unref();
      });
    } finally {
      await this.close();
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(url: string, response: import('node:http').ServerResponse): void {
    const parsed = new URL(url, 'http://127.0.0.1');
    if (parsed.pathname !== this.path) {
      response.writeHead(404).end('Not found');
      return;
    }

    const error = parsed.searchParams.get('error');
    const code = parsed.searchParams.get('code');
    const state = parsed.searchParams.get('state') ?? undefined;

    if (error) {
      this.respond(
        response,
        400,
        'Authorization failed',
        parsed.searchParams.get('error_description') ?? error,
      );
      this.fail?.(new Error(`Moneybird returned "${error}" instead of an authorization code`));
      return;
    }
    if (!code) {
      this.respond(
        response,
        400,
        'Authorization failed',
        'No authorization code was present in the redirect.',
      );
      this.fail?.(new Error('Redirect did not include an authorization code'));
      return;
    }
    if (this.expectedState !== undefined && state !== this.expectedState) {
      this.respond(response, 400, 'Authorization failed', 'The state parameter did not match.');
      this.fail?.(new Error('OAuth state mismatch — the response may not belong to this request'));
      return;
    }

    this.respond(
      response,
      200,
      'Connected to Moneybird',
      'You can close this tab and return to your terminal.',
    );
    this.settle?.({ code, state });
  }

  private respond(
    response: import('node:http').ServerResponse,
    status: number,
    title: string,
    detail: string,
  ): void {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#0f1115;color:#e8eaed}
main{text-align:center;max-width:32rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#9aa0a6}</style>
</head><body><main><h1>${title}</h1><p>${detail}</p></main></body></html>`;
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  }
}

/** Opaque value tying an authorization response back to the request that started it. */
export function createState(): string {
  return randomUUID();
}
