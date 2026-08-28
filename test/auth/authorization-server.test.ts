import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AuthorizationServer,
  redirectUriMatches,
} from '../../src/auth/server/authorization-server.js';
import { ClientMetadataFetcher } from '../../src/auth/server/client-metadata.js';
import { MemoryAuthorizationStore } from '../support/memory-store.js';

const ISSUER = 'https://mcp.example.com';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

const VERIFIER = randomBytes(32).toString('base64url');
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

interface StubOptions {
  administrations?: Array<Record<string, unknown>>;
  accessToken?: string;
  clientMetadata?: ClientMetadataFetcher;
}

/** A Moneybird stand-in: the token endpoint and the administrations call, nothing else. */
function moneybirdStub(options: StubOptions = {}) {
  const administrations = options.administrations ?? [
    // Moneybird sends ids as strings: they exceed what a JSON number can hold exactly.
    { id: '391695781953799753', name: 'Studio Souf', country: 'NL', currency: 'EUR' },
  ];
  const calls: string[] = [];

  const fetchImpl = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${init?.method ?? 'GET'} ${url}`);

    if (url === 'https://moneybird.com/oauth/token') {
      return new Response(
        JSON.stringify({
          access_token: options.accessToken ?? 'mb-access',
          refresh_token: 'mb-refresh',
          token_type: 'bearer',
          scope: 'sales_invoices documents',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.startsWith('https://moneybird.com/api/v2/administrations')) {
      return new Response(JSON.stringify(administrations), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof globalThis.fetch;

  return { fetch: fetchImpl, calls };
}

function build(options: StubOptions = {}) {
  const store = new MemoryAuthorizationStore();
  const stub = moneybirdStub(options);
  const server = new AuthorizationServer({
    store,
    issuer: ISSUER,
    endpoint: '/mcp',
    clientId: 'upstream-client',
    clientSecret: 'upstream-secret',
    scopes: ['sales_invoices', 'documents'],
    fetch: stub.fetch,
    ...(options.clientMetadata ? { clientMetadata: options.clientMetadata } : {}),
  });
  return { store, server, stub };
}

async function handled(server: AuthorizationServer, request: Request): Promise<Response> {
  const response = await server.handle(request);
  if (!response) throw new Error(`No route handled ${request.method} ${request.url}`);
  return response;
}

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie');
  if (!header) throw new Error('No cookie was set');
  return header.split(';')[0] ?? '';
}

async function registerClient(server: AuthorizationServer): Promise<string> {
  const response = await handled(
    server,
    new Request(`${ISSUER}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: 'Claude' }),
    }),
  );
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

/** Walks the flow up to the point where the client holds an authorization code. */
async function authorizeUntilCode(server: AuthorizationServer, clientId: string) {
  const started = await handled(
    server,
    new Request(
      `${ISSUER}/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=client-state` +
        `&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
    ),
  );
  const cookie = cookieFrom(started);

  const callback = await handled(
    server,
    new Request(`${ISSUER}/oauth/callback?code=moneybird-code`, { headers: { cookie } }),
  );

  return { started, callback, cookie };
}

describe('discovery', () => {
  it('publishes protected resource metadata pointing at itself', async () => {
    const { server } = build();
    const response = await handled(
      server,
      new Request(`${ISSUER}/.well-known/oauth-protected-resource`),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(body['resource']).toBe(`${ISSUER}/mcp`);
    expect(body['authorization_servers']).toEqual([ISSUER]);
  });

  it('answers the path-suffixed spelling of the well-known name too', async () => {
    const { server } = build();
    const response = await handled(
      server,
      new Request(`${ISSUER}/.well-known/oauth-protected-resource/mcp`),
    );
    expect(response.status).toBe(200);
  });

  it('advertises PKCE and public clients', async () => {
    const { server } = build();
    const response = await handled(
      server,
      new Request(`${ISSUER}/.well-known/oauth-authorization-server`),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(body['code_challenge_methods_supported']).toEqual(['S256']);
    expect(body['token_endpoint_auth_methods_supported']).toEqual(['none']);
    expect(body['registration_endpoint']).toBe(`${ISSUER}/register`);
  });

  it('names the metadata document in the 401 that starts discovery', () => {
    const { server } = build();
    const response = server.unauthorized('no token');

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      `resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`,
    );
  });
});

describe('registration', () => {
  it('issues a client id for a client that registers itself', async () => {
    const { server, store } = build();
    const clientId = await registerClient(server);

    expect(clientId).toBeTruthy();
    expect(await store.findClient(clientId)).toMatchObject({
      clientName: 'Claude',
      tokenEndpointAuthMethod: 'none',
    });
  });

  it('refuses a redirect uri that is neither https nor loopback', async () => {
    const { server } = build();
    const response = await handled(
      server,
      new Request(`${ISSUER}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['http://evil.example.com/cb'] }),
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: 'invalid_redirect_uri',
    });
  });

  it('accepts a loopback uri, which is how a desktop client comes back', async () => {
    const { server } = build();
    const response = await handled(
      server,
      new Request(`${ISSUER}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:33418/callback'] }),
      }),
    );
    expect(response.status).toBe(201);
  });
});

describe('authorize', () => {
  it('sends the user to Moneybird and remembers the request in a cookie', async () => {
    const { server, store } = build();
    const clientId = await registerClient(server);

    const response = await handled(
      server,
      new Request(
        `${ISSUER}/authorize?response_type=code&client_id=${clientId}` +
          `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=client-state` +
          `&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
      ),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe('https://moneybird.com/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe('upstream-client');
    expect(location.searchParams.get('redirect_uri')).toBe(`${ISSUER}/oauth/callback`);

    const requestId = location.searchParams.get('state');
    expect(cookieFrom(response)).toBe(`mb_authorization=${requestId}`);
    expect(await store.findAuthorizationRequest(requestId ?? '')).toMatchObject({
      clientId,
      clientState: 'client-state',
      codeChallenge: CHALLENGE,
    });
  });

  it('rejects an authorization without PKCE by redirecting an error back', async () => {
    const { server } = build();
    const clientId = await registerClient(server);

    const response = await handled(
      server,
      new Request(
        `${ISSUER}/authorize?response_type=code&client_id=${clientId}` +
          `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=client-state`,
      ),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin).toBe('https://claude.ai');
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('client-state');
  });

  it('renders an error rather than redirecting when the client is unknown', async () => {
    const { server } = build();
    const response = await handled(
      server,
      new Request(
        `${ISSUER}/authorize?response_type=code&client_id=nobody` +
          `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
          `&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
      ),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('text/html');
  });
});

describe('the full flow', () => {
  it('binds the only administration and hands the client a code', async () => {
    const { server, store } = build();
    const clientId = await registerClient(server);
    const { callback } = await authorizeUntilCode(server, clientId);

    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get('state')).toBe('client-state');
    expect(location.searchParams.get('code')).toBeTruthy();

    const credential = [...store.credentials.values()][0];
    expect(credential).toMatchObject({
      accessToken: 'mb-access',
      administrationId: '391695781953799753',
    });
  });

  it('exchanges the code for a token that resolves to the Moneybird credential', async () => {
    const { server } = build();
    const clientId = await registerClient(server);
    const { callback } = await authorizeUntilCode(server, clientId);
    const code = new URL(callback.headers.get('location') ?? '').searchParams.get('code') ?? '';

    const response = await handled(
      server,
      new Request(`${ISSUER}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: VERIFIER,
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
        }),
      }),
    );

    const body = (await response.json()) as { access_token: string; refresh_token: string };
    expect(body.access_token).toBeTruthy();

    const caller = await server.authenticateBearer(body.access_token);
    expect(caller).toEqual({ token: 'mb-access', administrationId: '391695781953799753' });
  });

  it('refuses a token exchange whose PKCE verifier does not match', async () => {
    const { server } = build();
    const clientId = await registerClient(server);
    const { callback } = await authorizeUntilCode(server, clientId);
    const code = new URL(callback.headers.get('location') ?? '').searchParams.get('code') ?? '';

    const response = await handled(
      server,
      new Request(`${ISSUER}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: randomBytes(32).toString('base64url'),
          client_id: clientId,
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: 'invalid_grant',
    });
  });

  it('treats a replayed code as a leak and revokes the whole authorization', async () => {
    const { server, store } = build();
    const clientId = await registerClient(server);
    const { callback } = await authorizeUntilCode(server, clientId);
    const code = new URL(callback.headers.get('location') ?? '').searchParams.get('code') ?? '';

    const exchange = () =>
      handled(
        server,
        new Request(`${ISSUER}/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            code_verifier: VERIFIER,
            client_id: clientId,
          }),
        }),
      );

    const first = await exchange();
    const issued = (await first.json()) as { access_token: string };
    const replay = await exchange();

    expect(replay.status).toBe(400);
    expect([...store.credentials.values()][0]?.revokedAt).toBeInstanceOf(Date);
    expect(await server.authenticateBearer(issued.access_token)).toBeUndefined();
  });

  it('rotates the refresh token and keeps the same Moneybird credential', async () => {
    const { server, store } = build();
    const clientId = await registerClient(server);
    const { callback } = await authorizeUntilCode(server, clientId);
    const code = new URL(callback.headers.get('location') ?? '').searchParams.get('code') ?? '';

    const first = await handled(
      server,
      new Request(`${ISSUER}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: VERIFIER,
          client_id: clientId,
        }),
      }),
    );
    const issued = (await first.json()) as { access_token: string; refresh_token: string };

    const refreshed = await handled(
      server,
      new Request(`${ISSUER}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: issued.refresh_token,
          client_id: clientId,
        }),
      }),
    );
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string };

    expect(next.access_token).not.toBe(issued.access_token);
    expect(await server.authenticateBearer(next.access_token)).toEqual({
      token: 'mb-access',
      administrationId: '391695781953799753',
    });
    expect(store.credentials.size).toBe(1);

    // The rotated token dies with the exchange it came from.
    const reuse = await handled(
      server,
      new Request(`${ISSUER}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: issued.refresh_token,
          client_id: clientId,
        }),
      }),
    );
    expect(reuse.status).toBe(400);
  });

  it('revokes everything issued for an authorization when one token is revoked', async () => {
    const { server } = build();
    const clientId = await registerClient(server);
    const { callback } = await authorizeUntilCode(server, clientId);
    const code = new URL(callback.headers.get('location') ?? '').searchParams.get('code') ?? '';

    const issued = (await (
      await handled(
        server,
        new Request(`${ISSUER}/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            code_verifier: VERIFIER,
            client_id: clientId,
          }),
        }),
      )
    ).json()) as { access_token: string };

    await handled(
      server,
      new Request(`${ISSUER}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: issued.access_token }),
      }),
    );

    expect(await server.authenticateBearer(issued.access_token)).toBeUndefined();
  });
});

describe('choosing an administration', () => {
  const two = [
    { id: '1', name: 'Studio Souf', country: 'NL', currency: 'EUR' },
    { id: '2', name: 'UltimateLemon', country: 'NL', currency: 'EUR' },
  ];

  it('asks which administration to use when the token reaches more than one', async () => {
    const { server } = build({ administrations: two });
    const clientId = await registerClient(server);
    const { callback } = await authorizeUntilCode(server, clientId);

    expect(callback.status).toBe(200);
    const html = await callback.text();
    expect(html).toContain('Studio Souf');
    expect(html).toContain('UltimateLemon');
  });

  it('binds the chosen administration and then returns to the client', async () => {
    const { server, store } = build({ administrations: two });
    const clientId = await registerClient(server);
    const { cookie } = await authorizeUntilCode(server, clientId);

    const response = await handled(
      server,
      new Request(`${ISSUER}/oauth/select`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ administration_id: '2' }),
      }),
    );

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('code')).toBeTruthy();
    expect([...store.credentials.values()][0]?.administrationId).toBe('2');
  });

  it('lets the user decline a default and still finish the authorization', async () => {
    const { server, store } = build({ administrations: two });
    const clientId = await registerClient(server);
    const { cookie } = await authorizeUntilCode(server, clientId);

    const response = await handled(
      server,
      new Request(`${ISSUER}/oauth/select`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ skip: '1' }),
      }),
    );

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('code')).toBeTruthy();
    expect([...store.credentials.values()][0]?.administrationId).toBeUndefined();
  });

  it('says the choice is a default rather than a restriction', async () => {
    const { server } = build({ administrations: two });
    const clientId = await registerClient(server);
    const { callback } = await authorizeUntilCode(server, clientId);

    const html = await callback.text();
    expect(html).toContain('reaches all of them');
  });

  it('refuses an administration the credential cannot reach', async () => {
    const { server, store } = build({ administrations: two });
    const clientId = await registerClient(server);
    const { cookie } = await authorizeUntilCode(server, clientId);

    const response = await handled(
      server,
      new Request(`${ISSUER}/oauth/select`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ administration_id: '999' }),
      }),
    );

    expect(response.status).toBe(400);
    expect([...store.credentials.values()][0]?.administrationId).toBeUndefined();
  });
});

describe('redirectUriMatches', () => {
  it('matches an identical uri', () => {
    expect(redirectUriMatches(REDIRECT_URI, REDIRECT_URI)).toBe(true);
  });

  it('ignores the port on loopback, which is the only way a native client can come back', () => {
    expect(redirectUriMatches('http://localhost/callback', 'http://localhost:3118/callback')).toBe(
      true,
    );
    expect(redirectUriMatches('http://127.0.0.1/callback', 'http://127.0.0.1:51739/callback')).toBe(
      true,
    );
  });

  it('does not ignore the port anywhere else', () => {
    expect(
      redirectUriMatches(
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.ai:8443/api/mcp/auth_callback',
      ),
    ).toBe(false);
    expect(redirectUriMatches('http://example.com/cb', 'http://example.com:8080/cb')).toBe(false);
  });

  it('still requires the rest of the uri to agree', () => {
    expect(redirectUriMatches('http://localhost/callback', 'http://localhost:3118/other')).toBe(
      false,
    );
    expect(redirectUriMatches('http://localhost/callback', 'http://127.0.0.1:3118/callback')).toBe(
      false,
    );
  });
});

describe('clients identified by url', () => {
  const CLIENT_ID = 'https://claude.ai/oauth/claude-code-client-metadata';

  function metadataFetcher(document?: Record<string, unknown>): ClientMetadataFetcher {
    return new ClientMetadataFetcher({
      fetch: (async () =>
        new Response(
          JSON.stringify(
            document ?? {
              client_id: CLIENT_ID,
              client_name: 'Claude Code',
              redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
              token_endpoint_auth_method: 'none',
            },
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof globalThis.fetch,
      resolveHost: async () => ['104.18.0.1'],
    });
  }

  it('advertises the mechanism alongside public clients, which is what makes Claude pick it', async () => {
    const { server } = build();
    const response = await handled(
      server,
      new Request(`${ISSUER}/.well-known/oauth-authorization-server`),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(body['client_id_metadata_document_supported']).toBe(true);
    expect(body['token_endpoint_auth_methods_supported']).toEqual(['none']);
  });

  it('authorizes a client that never registered, on an ephemeral loopback port', async () => {
    const { server, store } = build({ clientMetadata: metadataFetcher() });

    const response = await handled(
      server,
      new Request(
        `${ISSUER}/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}` +
          `&redirect_uri=${encodeURIComponent('http://localhost:3118/callback')}&state=s` +
          `&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location') ?? '').toContain(
      'https://moneybird.com/oauth/authorize',
    );

    // Recorded like any other client, so codes, tokens and revocation need no special case.
    expect(await store.findClient(CLIENT_ID)).toMatchObject({
      clientName: 'Claude Code',
      tokenEndpointAuthMethod: 'none',
    });
  });

  it('refuses a redirect uri the document does not declare', async () => {
    const { server } = build({ clientMetadata: metadataFetcher() });

    const response = await handled(
      server,
      new Request(
        `${ISSUER}/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}` +
          `&redirect_uri=${encodeURIComponent('https://evil.example/cb')}` +
          `&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('redirect uri');
  });

  it('explains itself when the document cannot be read', async () => {
    const { server } = build({
      clientMetadata: metadataFetcher({ client_id: 'https://elsewhere.example/x' }),
    });

    const response = await handled(
      server,
      new Request(
        `${ISSUER}/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}` +
          `&redirect_uri=${encodeURIComponent('http://localhost:3118/callback')}` +
          `&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('does not match');
  });
});
