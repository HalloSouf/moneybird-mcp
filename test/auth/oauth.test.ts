import { describe, expect, it } from 'vitest';
import {
  OAuthError,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
} from '../../src/auth/oauth.js';
import { stubFetch } from '../support/fetch.js';

describe('buildAuthorizeUrl', () => {
  it('builds the authorize URL with client id, redirect uri and space-joined scopes', () => {
    const url = buildAuthorizeUrl({
      clientId: 'client-1',
      redirectUri: 'http://localhost:1234/callback',
      scopes: ['sales_invoices', 'documents'],
    });

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://moneybird.com/oauth/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('client-1');
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://localhost:1234/callback');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('scope')).toBe('sales_invoices documents');
    expect(parsed.searchParams.has('state')).toBe(false);
  });

  it('includes state when supplied', () => {
    const url = buildAuthorizeUrl({
      clientId: 'client-1',
      redirectUri: 'http://localhost:1234/callback',
      scopes: ['bank'],
      state: 'xyz',
    });
    expect(new URL(url).searchParams.get('state')).toBe('xyz');
  });
});

describe('exchangeCode', () => {
  it('posts a form-encoded authorization_code request and parses the token response', async () => {
    const http = stubFetch({
      body: {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        token_type: 'bearer',
        scope: 'bank documents',
      },
    });

    const token = await exchangeCode({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      code: 'auth-code',
      redirectUri: 'http://localhost:1234/callback',
      fetch: http.fetch,
    });

    const request = http.lastRequest();
    expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(request.body).toBe(
      'client_id=client-1&client_secret=secret-1&code=auth-code&' +
        'redirect_uri=http%3A%2F%2Flocalhost%3A1234%2Fcallback&grant_type=authorization_code',
    );
    expect(token).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      tokenType: 'bearer',
      scopes: ['bank', 'documents'],
      expiresAt: undefined,
    });
  });

  it('computes expiresAt from expires_in using the injected clock', async () => {
    const http = stubFetch({ body: { access_token: 'access-1', expires_in: 3600 } });

    const token = await exchangeCode({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      code: 'auth-code',
      redirectUri: 'http://localhost:1234/callback',
      fetch: http.fetch,
      now: () => 1_000_000 * 1000,
    });

    expect(token.expiresAt).toBe(1_000_000 + 3600);
  });

  it('leaves expiresAt undefined when expires_in is absent', async () => {
    const http = stubFetch({ body: { access_token: 'access-1' } });
    const token = await exchangeCode({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      code: 'auth-code',
      redirectUri: 'http://localhost:1234/callback',
      fetch: http.fetch,
    });
    expect(token.expiresAt).toBeUndefined();
  });

  it('turns an {error, error_description} body into an OAuthError carrying the code', async () => {
    const http = stubFetch({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'The code has expired' },
    });

    const error = await exchangeCode({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      code: 'auth-code',
      redirectUri: 'http://localhost:1234/callback',
      fetch: http.fetch,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OAuthError);
    expect((error as OAuthError).code).toBe('invalid_grant');
    expect((error as OAuthError).message).toBe('The code has expired');
    expect((error as OAuthError).status).toBe(400);
  });
});

describe('refreshAccessToken', () => {
  it('posts a form-encoded refresh_token request', async () => {
    const http = stubFetch({ body: { access_token: 'access-2' } });

    await refreshAccessToken({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      refreshToken: 'refresh-1',
      fetch: http.fetch,
    });

    const request = http.lastRequest();
    expect(request.body).toBe(
      'client_id=client-1&client_secret=secret-1&refresh_token=refresh-1&grant_type=refresh_token',
    );
  });

  it('falls back to error code when error_description is absent', async () => {
    const http = stubFetch({ status: 401, body: { error: 'invalid_client' } });

    const error = await refreshAccessToken({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      refreshToken: 'refresh-1',
      fetch: http.fetch,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OAuthError);
    expect((error as OAuthError).message).toBe('invalid_client');
  });
});
