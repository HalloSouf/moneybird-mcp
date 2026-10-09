import type { OAuthScope } from '../config/schema.js';
import type { ConnectedAdministration, ConnectionStore } from '../db/connections.js';
import { MoneybirdClient } from '../moneybird/client.js';
import { buildAuthorizeUrl, exchangeCode, OAuthError, refreshAccessToken } from './oauth.js';
import { MissingCredentialsError } from './provider.js';
import { hashToken, randomToken } from './server/crypto.js';
import { connectedPage, connectPage, errorPage, htmlResponse } from './server/pages.js';

export const USER_HEADER = 'x-airlock-user';
export const EMAIL_HEADER = 'x-airlock-email';

/** Subpaths of the MCP endpoint that Airlock serves without a token (`airlock.public`). */
export const PUBLIC_SUBPATHS = ['/connect', '/oauth/callback'] as const;

const TICKET_TTL_MS = 10 * 60 * 1000;
const REFRESH_LEEWAY_MS = 300 * 1000;

export interface AirlockAccountsOptions {
  store: ConnectionStore;
  /** The MCP endpoint as the browser reaches it, e.g. `https://mcp.example.com/moneybird`. */
  publicUrl: string;
  /** Path the MCP endpoint is served on locally; public subpaths live below it. */
  endpoint: string;
  clientId: string;
  clientSecret: string;
  scopes: readonly OAuthScope[];
  baseUrl?: string | undefined;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export interface Caller {
  userId: string;
  email: string | undefined;
}

export interface UserAccount {
  caller: Caller;
  administrations: readonly ConnectedAdministration[];
  /** The administration used when a call names none: only when there is exactly one. */
  defaultAdministrationId: string | undefined;
  getToken(administrationId?: string): Promise<string>;
  connectUrl(): Promise<string>;
  disconnect(administrationId: string): Promise<boolean>;
}

export function callerFrom(request: Request): Caller | undefined {
  const userId = request.headers.get(USER_HEADER)?.trim();
  if (!userId) return undefined;
  const email = request.headers.get(EMAIL_HEADER)?.trim();
  return { userId, email: email || undefined };
}

export class AirlockAccounts {
  private readonly options: AirlockAccountsOptions;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  // A refresh token is single-use, so concurrent calls on a connection share one load.
  private readonly loading = new Map<string, Promise<string>>();

  constructor(options: AirlockAccountsOptions) {
    this.options = { ...options, publicUrl: options.publicUrl.replace(/\/+$/, '') };
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  private get callbackUri(): string {
    return `${this.options.publicUrl}/oauth/callback`;
  }

  async handle(request: Request): Promise<Response | undefined> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return undefined;
    const url = new URL(request.url);
    if (!url.pathname.startsWith(this.options.endpoint)) return undefined;
    const subpath = url.pathname.slice(this.options.endpoint.length);
    if (subpath === '/connect') return this.connect(url);
    if (subpath === '/oauth/callback') return this.callback(url);
    return undefined;
  }

  async forCaller(caller: Caller): Promise<UserAccount> {
    const { store } = this.options;
    const administrations = await store.listAdministrations(caller.userId);
    const only = administrations.length === 1 ? administrations[0] : undefined;

    return {
      caller,
      administrations,
      defaultAdministrationId: only?.administrationId,
      getToken: async (administrationId) => {
        const target =
          administrationId ?? only?.administrationId ?? administrations[0]?.administrationId;
        const match = administrations.find((entry) => entry.administrationId === target);
        if (!match) {
          throw new MissingCredentialsError(
            administrations.length === 0
              ? 'No Moneybird administration is connected yet. Call connect_moneybird.'
              : `Administration ${target ?? ''} is not connected. Connected: ` +
                  `${administrations.map((entry) => `${entry.name} (${entry.administrationId})`).join(', ')}. ` +
                  'Call connect_moneybird to add another.',
          );
        }
        return this.tokenFor(match.connectionId);
      },
      connectUrl: () => this.createConnectUrl(caller),
      disconnect: (administrationId) => store.disconnect(caller.userId, administrationId),
    };
  }

  private async createConnectUrl(caller: Caller): Promise<string> {
    const ticket = randomToken();
    await this.options.store.createTicket(
      hashToken(ticket),
      caller.userId,
      caller.email,
      new Date(this.now() + TICKET_TTL_MS),
    );
    await this.options.store.deleteExpiredTickets(new Date(this.now()));
    return `${this.options.publicUrl}/connect?ticket=${encodeURIComponent(ticket)}`;
  }

  // Only shows a confirmation; the ticket is spent at the callback. The page names the account
  // the authorization will land on, which is the defence against someone else's link.
  private async connect(url: URL): Promise<Response> {
    const ticket = url.searchParams.get('ticket');
    const found = ticket ? await this.options.store.findTicket(hashToken(ticket)) : undefined;
    if (!ticket || !found || found.usedAt || found.expiresAt.getTime() <= this.now()) {
      return htmlResponse(
        errorPage(
          'Link expired',
          'This link is used or expired. Ask for a new one from your conversation.',
        ),
        400,
      );
    }

    const authorizeUrl = buildAuthorizeUrl({
      clientId: this.options.clientId,
      redirectUri: this.callbackUri,
      scopes: this.options.scopes,
      state: ticket,
    });
    return htmlResponse(connectPage(found.email, authorizeUrl), 200);
  }

  private async callback(url: URL): Promise<Response> {
    const failure = url.searchParams.get('error');
    if (failure) {
      return htmlResponse(
        errorPage(
          'Moneybird refused the authorization',
          url.searchParams.get('error_description') ?? failure,
        ),
        400,
      );
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) {
      return htmlResponse(
        errorPage('Invalid callback', 'Moneybird returned no code or state.'),
        400,
      );
    }

    const ticket = await this.options.store.consumeTicket(hashToken(state), new Date(this.now()));
    if (!ticket) {
      return htmlResponse(
        errorPage(
          'Link expired',
          'This link is used or expired. Ask for a new one from your conversation.',
        ),
        400,
      );
    }

    let tokens;
    try {
      tokens = await exchangeCode({
        clientId: this.options.clientId,
        clientSecret: this.options.clientSecret,
        code,
        redirectUri: this.callbackUri,
        fetch: this.fetchImpl,
        now: this.now,
      });
    } catch (error) {
      const detail = error instanceof OAuthError ? error.message : 'The exchange failed.';
      return htmlResponse(errorPage('Could not reach Moneybird', detail), 502);
    }

    const administrations = await this.administrationsFor(tokens.accessToken);
    if (administrations.length === 0) {
      return htmlResponse(
        errorPage('No administrations', 'This authorization reaches no administration.'),
        400,
      );
    }

    await this.options.store.saveConnection({
      id: randomToken(16),
      userId: ticket.userId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt === undefined ? undefined : new Date(tokens.expiresAt * 1000),
      scopes: tokens.scopes,
      administrations,
    });

    return htmlResponse(connectedPage(administrations.map((entry) => entry.name)), 200);
  }

  private async administrationsFor(token: string): Promise<Array<{ id: string; name: string }>> {
    const client = new MoneybirdClient({
      token,
      ...(this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {}),
      fetch: this.fetchImpl,
      maxRetries: 0,
    });
    const response = await client.get<Array<{ id: string | number; name?: string }>>(
      'administrations',
      { administrationScoped: false },
    );
    if (!Array.isArray(response.data)) return [];
    return response.data.map((entry) => ({
      id: String(entry.id),
      name: entry.name ?? String(entry.id),
    }));
  }

  private tokenFor(connectionId: string): Promise<string> {
    const inFlight = this.loading.get(connectionId);
    if (inFlight) return inFlight;
    const pending = this.loadToken(connectionId).finally(() => this.loading.delete(connectionId));
    this.loading.set(connectionId, pending);
    return pending;
  }

  private async loadToken(connectionId: string): Promise<string> {
    const connection = await this.options.store.findConnection(connectionId);
    if (!connection) {
      throw new MissingCredentialsError(
        'This connection no longer exists. Call connect_moneybird.',
      );
    }
    const expiresAt = connection.expiresAt?.getTime();
    if (expiresAt === undefined || expiresAt - REFRESH_LEEWAY_MS > this.now()) {
      return connection.accessToken;
    }
    if (!connection.refreshToken) {
      throw new MissingCredentialsError(
        'The Moneybird authorization expired. Call connect_moneybird to authorize again.',
      );
    }

    const tokens = await refreshAccessToken({
      clientId: this.options.clientId,
      clientSecret: this.options.clientSecret,
      refreshToken: connection.refreshToken,
      fetch: this.fetchImpl,
      now: this.now,
    });
    await this.options.store.updateTokens(connectionId, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt === undefined ? undefined : new Date(tokens.expiresAt * 1000),
    });
    return tokens.accessToken;
  }
}
