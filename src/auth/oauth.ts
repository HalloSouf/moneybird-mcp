import type { OAuthScope } from '../config/schema.js';

export const AUTHORIZE_URL = 'https://moneybird.com/oauth/authorize';
export const TOKEN_URL = 'https://moneybird.com/oauth/token';
export const REVOKE_URL = 'https://moneybird.com/oauth/revoke';

/** Where a user creates either a personal API token or an OAuth application. */
export const APPLICATIONS_URL = 'https://moneybird.com/user/applications/new';

/**
 * Moneybird displays the authorization code in the browser instead of redirecting.
 * Useful when no loopback listener can be opened, e.g. inside a container.
 */
export const OOB_REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

export interface AuthorizeUrlOptions {
  clientId: string;
  redirectUri: string;
  scopes: readonly OAuthScope[];
  state?: string | undefined;
}

export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', options.scopes.join(' '));
  if (options.state) url.searchParams.set('state', options.state);
  return url.toString();
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | undefined;
  tokenType: string;
  scopes: string[];
  /** Unix epoch seconds. Undefined while Moneybird issues non-expiring tokens. */
  expiresAt: number | undefined;
}

export class OAuthError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string | undefined) {
    super(message);
    this.name = 'OAuthError';
    this.status = status;
    this.code = code;
  }
}

interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  scope?: unknown;
  expires_in?: unknown;
  created_at?: unknown;
  error?: unknown;
  error_description?: unknown;
}

function parseTokenResponse(raw: RawTokenResponse, now: number): TokenResponse {
  if (typeof raw.access_token !== 'string' || raw.access_token === '') {
    throw new OAuthError('Token response did not contain an access_token', 200);
  }

  const expiresIn = typeof raw.expires_in === 'number' ? raw.expires_in : undefined;
  const scope = typeof raw.scope === 'string' ? raw.scope : '';

  return {
    accessToken: raw.access_token,
    refreshToken: typeof raw.refresh_token === 'string' ? raw.refresh_token : undefined,
    tokenType: typeof raw.token_type === 'string' ? raw.token_type : 'bearer',
    scopes: scope.split(/[\s,]+/).filter((entry) => entry !== ''),
    expiresAt: expiresIn === undefined ? undefined : Math.floor(now / 1000) + expiresIn,
  };
}

async function postForm(
  url: string,
  params: Record<string, string>,
  fetchImpl: typeof globalThis.fetch,
): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(params).toString(),
  });
}

async function readTokenResponse(response: Response, now: number): Promise<TokenResponse> {
  const text = await response.text();
  let body: RawTokenResponse = {};
  try {
    body = text === '' ? {} : (JSON.parse(text) as RawTokenResponse);
  } catch {
    throw new OAuthError(`Unreadable token response: ${text.slice(0, 200)}`, response.status);
  }

  if (!response.ok || typeof body.error === 'string') {
    const code = typeof body.error === 'string' ? body.error : undefined;
    const description =
      typeof body.error_description === 'string' ? body.error_description : undefined;
    throw new OAuthError(
      description ?? code ?? `Token request failed with HTTP ${response.status}`,
      response.status,
      code,
    );
  }

  return parseTokenResponse(body, now);
}

export interface ExchangeOptions {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export async function exchangeCode(options: ExchangeOptions): Promise<TokenResponse> {
  const response = await postForm(
    TOKEN_URL,
    {
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code: options.code,
      redirect_uri: options.redirectUri,
      grant_type: 'authorization_code',
    },
    options.fetch ?? globalThis.fetch,
  );
  return readTokenResponse(response, (options.now ?? Date.now)());
}

export interface RefreshOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export async function refreshAccessToken(options: RefreshOptions): Promise<TokenResponse> {
  const response = await postForm(
    TOKEN_URL,
    {
      client_id: options.clientId,
      client_secret: options.clientSecret,
      refresh_token: options.refreshToken,
      grant_type: 'refresh_token',
    },
    options.fetch ?? globalThis.fetch,
  );
  return readTokenResponse(response, (options.now ?? Date.now)());
}

export interface RevokeOptions {
  clientId: string;
  clientSecret: string;
  token: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Revokes an authorization. Moneybird invalidates the access and refresh token together,
 * and answers 200 even for an unknown token, so success here does not prove the token existed.
 */
export async function revokeToken(options: RevokeOptions): Promise<void> {
  const response = await postForm(
    REVOKE_URL,
    {
      client_id: options.clientId,
      client_secret: options.clientSecret,
      token: options.token,
    },
    options.fetch ?? globalThis.fetch,
  );

  if (!response.ok) {
    throw new OAuthError(`Revoking the token failed with HTTP ${response.status}`, response.status);
  }
}
