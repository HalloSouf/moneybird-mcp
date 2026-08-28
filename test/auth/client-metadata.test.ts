import { describe, expect, it, vi } from 'vitest';
import {
  ClientMetadataError,
  ClientMetadataFetcher,
  isClientIdentifierUrl,
  isPublicAddress,
} from '../../src/auth/server/client-metadata.js';

const CLIENT_ID = 'https://claude.ai/oauth/claude-code-client-metadata';

function documentFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: CLIENT_ID,
    client_name: 'Claude Code',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    token_endpoint_auth_method: 'none',
    ...overrides,
  };
}

interface StubOptions {
  body?: unknown;
  status?: number;
  headers?: Record<string, string>;
}

function build(options: StubOptions = {}, now: () => number = () => 0) {
  const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const body =
      typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body ?? documentFor());
    return new Response(body, {
      status: options.status ?? 200,
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    });
  });

  const fetcher = new ClientMetadataFetcher({
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
    now,
    resolveHost: async () => ['104.18.0.1'],
  });

  return { fetcher, fetchImpl };
}

describe('isClientIdentifierUrl', () => {
  it('accepts an https url with a path', () => {
    expect(isClientIdentifierUrl(CLIENT_ID)).toBe(true);
  });

  it('rejects a registered id, which is what keeps the two mechanisms apart', () => {
    expect(isClientIdentifierUrl('k4_Ipy6anLTaGKw-MpTPBQ')).toBe(false);
  });

  it('rejects http, a bare origin, userinfo and fragments', () => {
    expect(isClientIdentifierUrl('http://claude.ai/oauth/metadata')).toBe(false);
    expect(isClientIdentifierUrl('https://claude.ai/')).toBe(false);
    expect(isClientIdentifierUrl('https://user:pw@claude.ai/oauth/metadata')).toBe(false);
    expect(isClientIdentifierUrl('https://claude.ai/oauth/metadata#x')).toBe(false);
  });
});

describe('isPublicAddress', () => {
  it('accepts ordinary public addresses', () => {
    expect(isPublicAddress('104.18.0.1')).toBe(true);
    expect(isPublicAddress('2606:4700::1')).toBe(true);
  });

  it('rejects the ranges that make SSRF worth attempting', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254', // the cloud metadata endpoint
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '2001:db8::1',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
});

describe('ClientMetadataFetcher', () => {
  it('resolves a document into a client identity', async () => {
    const { fetcher } = build();
    await expect(fetcher.resolve(CLIENT_ID)).resolves.toEqual({
      clientId: CLIENT_ID,
      clientName: 'Claude Code',
      redirectUris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    });
  });

  it('does not follow redirects', async () => {
    const { fetcher, fetchImpl } = build();
    await fetcher.resolve(CLIENT_ID);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('treats a redirect as an error rather than chasing it somewhere unchecked', async () => {
    const { fetcher } = build({ status: 302 });
    await expect(fetcher.resolve(CLIENT_ID)).rejects.toThrow(ClientMetadataError);
  });

  it('rejects a document that names a different client', async () => {
    const { fetcher } = build({ body: documentFor({ client_id: 'https://elsewhere.example/x' }) });
    await expect(fetcher.resolve(CLIENT_ID)).rejects.toThrow(/does not match/);
  });

  it('rejects a client that wants to authenticate with a shared secret', async () => {
    const { fetcher } = build({
      body: documentFor({ token_endpoint_auth_method: 'client_secret_basic' }),
    });
    await expect(fetcher.resolve(CLIENT_ID)).rejects.toThrow(/client_secret_basic/);
  });

  it('rejects a document without redirect uris', async () => {
    const { fetcher } = build({ body: documentFor({ redirect_uris: [] }) });
    await expect(fetcher.resolve(CLIENT_ID)).rejects.toThrow(/redirect_uris/);
  });

  it('stops reading past the size cap', async () => {
    const { fetcher } = build({ body: JSON.stringify(documentFor()) + ' '.repeat(6000) });
    await expect(fetcher.resolve(CLIENT_ID)).rejects.toThrow(/larger than/);
  });

  it('refuses a host that resolves to a private address', async () => {
    const fetcher = new ClientMetadataFetcher({
      fetch: (async () => new Response('{}')) as unknown as typeof globalThis.fetch,
      resolveHost: async () => ['169.254.169.254'],
    });
    await expect(fetcher.resolve(CLIENT_ID)).rejects.toThrow(/private address/);
  });

  it('refuses a literal private address without consulting dns', async () => {
    const fetcher = new ClientMetadataFetcher({
      fetch: (async () => new Response('{}')) as unknown as typeof globalThis.fetch,
      resolveHost: async () => {
        throw new Error('dns should not be consulted');
      },
    });
    await expect(fetcher.resolve('https://127.0.0.1/metadata')).rejects.toThrow(/private address/);
  });

  it('serves a second resolution from cache', async () => {
    const { fetcher, fetchImpl } = build();
    await fetcher.resolve(CLIENT_ID);
    await fetcher.resolve(CLIENT_ID);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refetches once the document's own cache lifetime has passed", async () => {
    let clock = 0;
    const { fetcher, fetchImpl } = build(
      { headers: { 'cache-control': 'max-age=60' } },
      () => clock,
    );

    await fetcher.resolve(CLIENT_ID);
    clock = 59_000;
    await fetcher.resolve(CLIENT_ID);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock = 61_000;
    await fetcher.resolve(CLIENT_ID);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never caches a failure', async () => {
    const { fetcher, fetchImpl } = build({ status: 500 });
    await expect(fetcher.resolve(CLIENT_ID)).rejects.toThrow();
    await expect(fetcher.resolve(CLIENT_ID)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
