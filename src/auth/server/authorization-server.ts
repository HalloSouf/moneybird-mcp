import type { OAuthScope } from '../../config/schema.js';
import type { AuthorizationStore, OAuthClient } from '../../db/types.js';
import {
  ClientMetadataError,
  ClientMetadataFetcher,
  isClientIdentifierUrl,
} from './client-metadata.js';
import { MoneybirdClient } from '../../moneybird/client.js';
import { buildAuthorizeUrl, exchangeCode, OAuthError, refreshAccessToken } from '../oauth.js';
import { hashToken, randomToken, verifyCodeChallenge } from './crypto.js';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata.js';
import { administrationPage, errorPage, htmlResponse, type AdministrationChoice } from './pages.js';

/** How long a user has to finish the Moneybird leg before the pending authorization expires. */
const REQUEST_TTL_MS = 10 * 60 * 1000;
/** Authorization codes are exchanged immediately; anything longer is only useful to an attacker. */
const CODE_TTL_MS = 60 * 1000;
/** Access tokens this server issues. Clients refresh; the Moneybird credential outlives them. */
const ACCESS_TTL_MS = 12 * 60 * 60 * 1000;
/** Refresh an upstream token this long before it expires, so no in-flight call races the deadline. */
const REFRESH_LEEWAY_SECONDS = 300;

const COOKIE_NAME = 'mb_authorization';

export interface AuthorizationServerOptions {
  store: AuthorizationStore;
  /** Public origin, without trailing slash, e.g. `https://moneybird-mcp.example.com`. */
  issuer: string;
  /** Path the MCP endpoint is served on. */
  endpoint: string;
  clientId: string;
  clientSecret: string;
  scopes: readonly OAuthScope[];
  baseUrl?: string | undefined;
  /** Resolves url-shaped client ids; constructed by default. */
  clientMetadata?: ClientMetadataFetcher;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export interface AuthenticatedCaller {
  /** The Moneybird token this request should act with. */
  token: string;
  /** The administration bound at authorization time, if one was chosen. */
  administrationId: string | undefined;
}

interface AdministrationResponse {
  id: string | number;
  name?: string;
  country?: string;
  currency?: string;
}

const JSON_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
} as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS } });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

function redirectTo(location: string, cookie?: string): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  if (cookie) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
}

function sessionCookie(value: string, maxAgeSeconds: number): string {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/** Appends `error` to the client's redirect uri, which is where OAuth failures belong. */
function redirectWithError(
  redirectUri: string,
  error: string,
  description: string,
  state: string | undefined,
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state !== undefined) url.searchParams.set('state', state);
  return redirectTo(url.toString(), `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; Max-Age=0`);
}

/**
 * A redirect uri this server is willing to send a user back to.
 *
 * https anywhere, plaintext http only on loopback — which is how a desktop client that listens on
 * 127.0.0.1 completes the flow, and the one case where http carries no risk of interception.
 */
function isAllowedRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash !== '') return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
}

/**
 * Whether a redirect uri satisfies one the client declared.
 *
 * Exact string comparison, with one exception RFC 8252 section 7.3 requires: a native client
 * listens on an ephemeral loopback port it cannot know in advance, so it registers the host
 * without a port and the port is ignored when matching. Everything else about the uri must still
 * agree, and the exception is confined to loopback addresses.
 */
export function redirectUriMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;

  let left: URL;
  let right: URL;
  try {
    left = new URL(registered);
    right = new URL(presented);
  } catch {
    return false;
  }

  const loopback = ['127.0.0.1', '[::1]', '::1', 'localhost'];
  if (left.protocol !== 'http:' || right.protocol !== 'http:') return false;
  if (left.hostname !== right.hostname) return false;
  if (!loopback.includes(left.hostname)) return false;

  return left.pathname === right.pathname && left.search === right.search;
}

/**
 * An OAuth 2.1 authorization server that fronts Moneybird.
 *
 * Moneybird supports neither Dynamic Client Registration nor PKCE, so an MCP client cannot speak
 * to it directly: it has nowhere to register, and no way to finish the code flow without holding
 * a client secret it must not have. This server closes both gaps by being the authorization
 * server the client talks to, and a confidential client towards Moneybird — the one place the
 * application secret lives. Clients receive tokens this server minted, which map to a Moneybird
 * credential nobody but this server can read.
 */
export class AuthorizationServer {
  private readonly store: AuthorizationStore;
  private readonly options: AuthorizationServerOptions;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly clientMetadata: ClientMetadataFetcher;
  /** In-flight upstream refreshes, so concurrent calls never burn a single-use refresh token. */
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(options: AuthorizationServerOptions) {
    this.store = options.store;
    this.options = options;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.clientMetadata =
      options.clientMetadata ?? new ClientMetadataFetcher({ fetch: this.fetchImpl, now: this.now });
  }

  /**
   * Finds the client behind a `client_id`, by either mechanism.
   *
   * A url is resolved to its metadata document and recorded, so a client that never registers
   * still becomes an ordinary row and everything downstream — codes, tokens, revocation — treats
   * it the same. Anything else is a registered id.
   */
  private async resolveClient(clientId: string): Promise<OAuthClient | undefined> {
    if (!isClientIdentifierUrl(clientId)) return this.store.findClient(clientId);

    const document = await this.clientMetadata.resolve(clientId);
    const client: OAuthClient = {
      clientId: document.clientId,
      clientName: document.clientName,
      redirectUris: document.redirectUris,
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      tokenEndpointAuthMethod: 'none',
    };
    await this.store.upsertClient(client);
    return client;
  }

  /** The 401 that starts discovery: it names the metadata document describing this server. */
  unauthorized(detail: string): Response {
    const resourceMetadata = `${this.options.issuer}/.well-known/oauth-protected-resource`;
    return new Response(JSON.stringify({ error: 'unauthorized', detail }), {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': `Bearer realm="moneybird-mcp", resource_metadata="${resourceMetadata}"`,
      },
    });
  }

  /** Routes a request if it belongs to the authorization server; otherwise hands it back. */
  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS' && this.owns(path)) {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version',
          'access-control-max-age': '86400',
        },
      });
    }

    // RFC 9728 lets a client append the resource path to the well-known name, so both spellings
    // have to answer or discovery fails for whichever one the client happens to try.
    if (request.method === 'GET' && path.startsWith('/.well-known/oauth-protected-resource')) {
      return json(
        protectedResourceMetadata({
          issuer: this.options.issuer,
          endpoint: this.options.endpoint,
        }),
      );
    }

    if (
      request.method === 'GET' &&
      (path.startsWith('/.well-known/oauth-authorization-server') ||
        path === '/.well-known/openid-configuration')
    ) {
      return json(
        authorizationServerMetadata({
          issuer: this.options.issuer,
          endpoint: this.options.endpoint,
        }),
      );
    }

    if (path === '/register' && request.method === 'POST') return this.register(request);
    if (path === '/authorize' && request.method === 'GET') return this.authorize(url);
    if (path === '/oauth/callback' && request.method === 'GET') return this.callback(request, url);
    if (path === '/oauth/select' && request.method === 'POST') return this.select(request);
    if (path === '/token' && request.method === 'POST') return this.token(request);
    if (path === '/revoke' && request.method === 'POST') return this.revoke(request);

    return undefined;
  }

  private owns(path: string): boolean {
    return (
      path.startsWith('/.well-known/') ||
      ['/register', '/authorize', '/oauth/callback', '/oauth/select', '/token', '/revoke'].includes(
        path,
      )
    );
  }

  /** RFC 7591 Dynamic Client Registration. Every client is public and must use PKCE. */
  private async register(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return oauthError('invalid_client_metadata', 'Body must be JSON.');
    }

    const redirectUris = body['redirect_uris'];
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return oauthError('invalid_redirect_uri', 'redirect_uris is required and must be non-empty.');
    }

    const uris: string[] = [];
    for (const entry of redirectUris) {
      if (typeof entry !== 'string' || !isAllowedRedirectUri(entry)) {
        return oauthError(
          'invalid_redirect_uri',
          `"${String(entry)}" is not an https uri or a loopback http uri.`,
        );
      }
      uris.push(entry);
    }

    const clientId = randomToken(16);
    const clientName = typeof body['client_name'] === 'string' ? body['client_name'] : undefined;

    await this.store.createClient({
      clientId,
      clientName,
      redirectUris: uris,
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      tokenEndpointAuthMethod: 'none',
    });

    return json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(this.now() / 1000),
        redirect_uris: uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(clientName ? { client_name: clientName } : {}),
      },
      201,
    );
  }

  /**
   * Starts an authorization.
   *
   * Until the client and its redirect uri are known to be genuine, errors are rendered here;
   * redirecting an error to an unverified uri would turn this endpoint into an open redirector.
   */
  private async authorize(url: URL): Promise<Response> {
    const params = url.searchParams;
    const clientId = params.get('client_id');
    const redirectUri = params.get('redirect_uri');
    const state = params.get('state') ?? undefined;

    if (!clientId || !redirectUri) {
      return htmlResponse(
        errorPage('Invalid request', 'client_id and redirect_uri are both required.'),
        400,
      );
    }

    let client: OAuthClient | undefined;
    try {
      client = await this.resolveClient(clientId);
    } catch (error) {
      return htmlResponse(
        errorPage(
          'Could not identify the client',
          error instanceof ClientMetadataError
            ? error.message
            : 'The client metadata document could not be read.',
        ),
        400,
      );
    }

    if (!client) {
      return htmlResponse(
        errorPage('Unknown client', 'This client is not registered with this server.'),
        400,
      );
    }
    if (!client.redirectUris.some((registered) => redirectUriMatches(registered, redirectUri))) {
      return htmlResponse(
        errorPage('Invalid redirect uri', 'This uri was not registered by this client.'),
        400,
      );
    }

    if (params.get('response_type') !== 'code') {
      return redirectWithError(
        redirectUri,
        'unsupported_response_type',
        'Only the authorization code flow is supported.',
        state,
      );
    }

    const codeChallenge = params.get('code_challenge');
    const method = params.get('code_challenge_method');
    if (!codeChallenge || method !== 'S256') {
      return redirectWithError(
        redirectUri,
        'invalid_request',
        'PKCE with code_challenge_method=S256 is required.',
        state,
      );
    }

    const id = randomToken(24);
    await this.store.createAuthorizationRequest({
      id,
      clientId,
      redirectUri,
      clientState: state,
      scope: params.get('scope') ?? undefined,
      codeChallenge,
      codeChallengeMethod: method,
      resource: params.get('resource') ?? undefined,
      credentialId: undefined,
      expiresAt: new Date(this.now() + REQUEST_TTL_MS),
    });

    const upstream = buildAuthorizeUrl({
      clientId: this.options.clientId,
      redirectUri: this.callbackUri(),
      scopes: this.options.scopes,
      state: id,
    });

    // The cookie, not `state`, is what the callback is correlated on: Moneybird's documentation
    // never promises to echo `state`, and the callback lands in the same browser either way.
    return redirectTo(upstream, sessionCookie(id, REQUEST_TTL_MS / 1000));
  }

  private callbackUri(): string {
    return `${this.options.issuer}/oauth/callback`;
  }

  /** Where Moneybird sends the user back. Exchanges its code and binds an administration. */
  private async callback(request: Request, url: URL): Promise<Response> {
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
    if (!code) {
      return htmlResponse(errorPage('Invalid callback', 'Moneybird returned no code.'), 400);
    }

    const requestId = url.searchParams.get('state') ?? readCookie(request, COOKIE_NAME);
    if (!requestId) {
      return htmlResponse(
        errorPage(
          'Lost the authorization',
          'This browser carries no pending authorization. Start again from your client.',
        ),
        400,
      );
    }

    const pending = await this.store.findAuthorizationRequest(requestId);
    if (!pending) {
      return htmlResponse(
        errorPage('Unknown authorization', 'This authorization is not on record. Start again.'),
        400,
      );
    }
    if (pending.expiresAt.getTime() < this.now()) {
      await this.store.deleteAuthorizationRequest(pending.id);
      return htmlResponse(
        errorPage('Authorization expired', 'It took too long to finish. Start again.'),
        400,
      );
    }

    let tokens;
    try {
      tokens = await exchangeCode({
        clientId: this.options.clientId,
        clientSecret: this.options.clientSecret,
        code,
        redirectUri: this.callbackUri(),
        fetch: this.fetchImpl,
        now: this.now,
      });
    } catch (error) {
      const detail = error instanceof OAuthError ? error.message : 'The exchange failed.';
      return htmlResponse(errorPage('Could not reach Moneybird', detail), 502);
    }

    const credentialId = randomToken(16);
    await this.store.createCredential({
      id: credentialId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt === undefined ? undefined : new Date(tokens.expiresAt * 1000),
      administrationId: undefined,
      scopes: tokens.scopes,
    });
    await this.store.attachCredential(pending.id, credentialId);

    const administrations = await this.administrationsFor(tokens.accessToken);
    if (administrations.length === 0) {
      return htmlResponse(
        errorPage(
          'No administrations',
          'This Moneybird account cannot reach any administration, so there is nothing to connect.',
        ),
        400,
      );
    }

    const only = administrations[0];
    if (administrations.length === 1 && only) {
      await this.store.setCredentialAdministration(credentialId, only.id);
      return this.finish(pending.id);
    }

    return htmlResponse(
      administrationPage(administrations, `${this.options.issuer}/oauth/select`),
      200,
    );
  }

  /** Records the administration the user picked, then completes the authorization. */
  private async select(request: Request): Promise<Response> {
    const requestId = readCookie(request, COOKIE_NAME);
    if (!requestId) {
      return htmlResponse(
        errorPage('Lost the authorization', 'This browser carries no pending authorization.'),
        400,
      );
    }

    const pending = await this.store.findAuthorizationRequest(requestId);
    if (!pending?.credentialId || pending.expiresAt.getTime() < this.now()) {
      return htmlResponse(
        errorPage('Authorization expired', 'It took too long to finish. Start again.'),
        400,
      );
    }

    const form = await request.formData();

    // Declining is a real answer: with several administrations in play, a default is a nuisance
    // as often as a convenience.
    if (form.get('skip') === '1') return this.finish(pending.id);

    const administrationId = form.get('administration_id');
    if (typeof administrationId !== 'string' || administrationId === '') {
      return htmlResponse(errorPage('Invalid choice', 'No administration was submitted.'), 400);
    }

    const credential = await this.store.findCredential(pending.credentialId);
    if (!credential) {
      return htmlResponse(errorPage('Unknown authorization', 'Start again.'), 400);
    }

    // Re-checked against Moneybird rather than trusted from the form: the value arrives from a
    // browser, and binding a credential to an administration it cannot reach would be a silent
    // misconfiguration that only surfaces on the first tool call.
    const administrations = await this.administrationsFor(credential.accessToken);
    if (!administrations.some((administration) => administration.id === administrationId)) {
      return htmlResponse(
        errorPage('Unknown administration', 'That administration is not on this authorization.'),
        400,
      );
    }

    await this.store.setCredentialAdministration(credential.id, administrationId);
    return this.finish(pending.id);
  }

  /** Mints our own authorization code and sends the browser back to the client. */
  private async finish(requestId: string): Promise<Response> {
    const pending = await this.store.findAuthorizationRequest(requestId);
    if (!pending?.credentialId) {
      return htmlResponse(errorPage('Unknown authorization', 'Start again.'), 400);
    }

    const code = randomToken();
    await this.store.createAuthorizationCode({
      codeHash: hashToken(code),
      clientId: pending.clientId,
      credentialId: pending.credentialId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      codeChallengeMethod: pending.codeChallengeMethod,
      resource: pending.resource,
      expiresAt: new Date(this.now() + CODE_TTL_MS),
    });
    await this.store.deleteAuthorizationRequest(pending.id);

    const target = new URL(pending.redirectUri);
    target.searchParams.set('code', code);
    if (pending.clientState !== undefined) target.searchParams.set('state', pending.clientState);

    return redirectTo(target.toString(), `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; Max-Age=0`);
  }

  private async administrationsFor(token: string): Promise<AdministrationChoice[]> {
    const client = new MoneybirdClient({
      token,
      ...(this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {}),
      fetch: this.fetchImpl,
      maxRetries: 0,
    });

    const response = await client.get<AdministrationResponse[]>('administrations', {
      administrationScoped: false,
    });
    if (!Array.isArray(response.data)) return [];

    return response.data.map((administration) => ({
      id: String(administration.id),
      name: administration.name ?? String(administration.id),
      country: administration.country,
      currency: administration.currency,
    }));
  }

  /** The token endpoint: `authorization_code` and `refresh_token`, both for public clients. */
  private async token(request: Request): Promise<Response> {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return oauthError('invalid_request', 'Body must be form-encoded.');
    }

    const grantType = form.get('grant_type');
    if (grantType === 'authorization_code') return this.exchangeAuthorizationCode(form);
    if (grantType === 'refresh_token') return this.exchangeRefreshToken(form);
    return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
  }

  private async exchangeAuthorizationCode(form: FormData): Promise<Response> {
    const code = form.get('code');
    const verifier = form.get('code_verifier');
    const clientId = form.get('client_id');
    const redirectUri = form.get('redirect_uri');

    if (typeof code !== 'string' || typeof verifier !== 'string' || typeof clientId !== 'string') {
      return oauthError('invalid_request', 'code, code_verifier and client_id are required.');
    }

    const found = await this.store.consumeAuthorizationCode(hashToken(code));
    if (!found) return oauthError('invalid_grant', 'Unknown authorization code.');

    // A code presented twice means it leaked. The safe reading is that whoever replayed it also
    // has the first exchange's tokens, so everything issued for this authorization goes.
    if (found.alreadyUsed) {
      await this.store.revokeTokensForCredential(found.code.credentialId);
      await this.store.revokeCredential(found.code.credentialId);
      return oauthError('invalid_grant', 'This authorization code was already used.');
    }

    const { code: stored } = found;
    if (stored.expiresAt.getTime() < this.now()) {
      return oauthError('invalid_grant', 'The authorization code expired.');
    }
    if (stored.clientId !== clientId) {
      return oauthError('invalid_grant', 'This code belongs to a different client.');
    }
    if (typeof redirectUri === 'string' && redirectUri !== stored.redirectUri) {
      return oauthError('invalid_grant', 'redirect_uri does not match the authorization.');
    }
    if (!verifyCodeChallenge(verifier, stored.codeChallenge, stored.codeChallengeMethod)) {
      return oauthError('invalid_grant', 'The PKCE verifier does not match.');
    }

    return this.issue(stored.clientId, stored.credentialId);
  }

  private async exchangeRefreshToken(form: FormData): Promise<Response> {
    const refreshToken = form.get('refresh_token');
    const clientId = form.get('client_id');
    if (typeof refreshToken !== 'string') {
      return oauthError('invalid_request', 'refresh_token is required.');
    }

    const existing = await this.store.findTokenByRefreshHash(hashToken(refreshToken));
    if (!existing || existing.revokedAt) {
      return oauthError('invalid_grant', 'Unknown or revoked refresh token.');
    }
    if (typeof clientId === 'string' && clientId !== existing.clientId) {
      return oauthError('invalid_grant', 'This refresh token belongs to a different client.');
    }

    const credential = await this.store.findCredential(existing.credentialId);
    if (!credential || credential.revokedAt) {
      return oauthError('invalid_grant', 'The Moneybird authorization behind this token is gone.');
    }

    // Rotation: the presented refresh token dies with the access token it came with.
    await this.store.revokeToken(existing.id);
    return this.issue(existing.clientId, existing.credentialId);
  }

  private async issue(clientId: string, credentialId: string): Promise<Response> {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const expiresAt = new Date(this.now() + ACCESS_TTL_MS);

    await this.store.createToken({
      id: randomToken(16),
      clientId,
      credentialId,
      accessTokenHash: hashToken(accessToken),
      refreshTokenHash: hashToken(refreshToken),
      expiresAt,
      revokedAt: undefined,
    });

    return json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refreshToken,
    });
  }

  /** RFC 7009. Revoking anything from an authorization revokes the whole authorization. */
  private async revoke(request: Request): Promise<Response> {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return oauthError('invalid_request', 'Body must be form-encoded.');
    }

    const token = form.get('token');
    if (typeof token !== 'string') {
      // RFC 7009 asks for 200 even for an unknown token, so a caller learns nothing from probing.
      return json({});
    }

    const hash = hashToken(token);
    const found =
      (await this.store.findTokenByAccessHash(hash)) ??
      (await this.store.findTokenByRefreshHash(hash));
    if (found) await this.store.revokeTokensForCredential(found.credentialId);

    return json({});
  }

  /**
   * Resolves a bearer token this server issued into the Moneybird credential behind it,
   * refreshing the upstream token first when it is close to expiring.
   */
  async authenticateBearer(presented: string): Promise<AuthenticatedCaller | undefined> {
    const token = await this.store.findTokenByAccessHash(hashToken(presented));
    if (!token || token.revokedAt || token.expiresAt.getTime() < this.now()) return undefined;

    const credential = await this.store.findCredential(token.credentialId);
    if (!credential || credential.revokedAt) return undefined;

    const expiresAt = credential.expiresAt;
    const needsRefresh =
      expiresAt !== undefined && expiresAt.getTime() - REFRESH_LEEWAY_SECONDS * 1000 <= this.now();

    if (!needsRefresh) {
      return { token: credential.accessToken, administrationId: credential.administrationId };
    }

    const refreshed = await this.refreshUpstream(credential.id, credential.refreshToken);
    return { token: refreshed, administrationId: credential.administrationId };
  }

  private async refreshUpstream(
    credentialId: string,
    refreshToken: string | undefined,
  ): Promise<string> {
    const inFlight = this.refreshing.get(credentialId);
    if (inFlight) return inFlight;

    const pending = (async () => {
      try {
        if (!refreshToken) {
          throw new OAuthError('The Moneybird token expired and has no refresh token.', 401);
        }
        const tokens = await refreshAccessToken({
          clientId: this.options.clientId,
          clientSecret: this.options.clientSecret,
          refreshToken,
          fetch: this.fetchImpl,
          now: this.now,
        });
        await this.store.updateCredentialTokens(credentialId, {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt === undefined ? undefined : new Date(tokens.expiresAt * 1000),
        });
        return tokens.accessToken;
      } finally {
        this.refreshing.delete(credentialId);
      }
    })();

    this.refreshing.set(credentialId, pending);
    return pending;
  }
}
