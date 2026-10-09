import { describe, expect, it } from 'vitest';
import { AirlockAccounts, callerFrom } from '../../src/auth/airlock.js';
import { MissingCredentialsError } from '../../src/auth/provider.js';
import { MemoryConnectionStore } from '../support/memory-connections.js';

const PUBLIC_URL = 'https://mcp.example.com/moneybird';
const LOCAL = 'http://moneybird:3000/mcp';
const CALLER = { userId: 'user-1', email: 'souf@example.com' };

interface StubOptions {
  administrations?: Array<{ id: string; name: string }>;
  expiresIn?: number;
}

function moneybirdStub(options: StubOptions = {}) {
  const calls: string[] = [];
  let issued = 0;

  const fetchImpl = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${init?.method ?? 'GET'} ${url}`);

    if (url === 'https://moneybird.com/oauth/token') {
      issued += 1;
      return Response.json({
        access_token: `mb-access-${issued}`,
        refresh_token: `mb-refresh-${issued}`,
        token_type: 'bearer',
        scope: 'sales_invoices documents',
        ...(options.expiresIn !== undefined
          ? { expires_in: options.expiresIn, created_at: Math.floor(Date.now() / 1000) }
          : {}),
      });
    }
    if (url.startsWith('https://moneybird.com/api/v2/administrations')) {
      return Response.json(
        options.administrations ?? [{ id: '391695781953799753', name: 'Studio Souf' }],
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof globalThis.fetch;

  return { fetch: fetchImpl, calls };
}

function build(options: StubOptions = {}, now: () => number = Date.now) {
  const store = new MemoryConnectionStore();
  const stub = moneybirdStub(options);
  const accounts = new AirlockAccounts({
    store,
    publicUrl: `${PUBLIC_URL}/`,
    endpoint: '/mcp',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    scopes: ['sales_invoices', 'documents'],
    fetch: stub.fetch,
    now,
  });
  return { accounts, store, stub };
}

async function get(accounts: AirlockAccounts, path: string): Promise<Response> {
  const response = await accounts.handle(new Request(`${LOCAL}${path}`));
  if (!response) throw new Error(`${path} was not handled`);
  return response;
}

async function connect(accounts: AirlockAccounts, caller = CALLER): Promise<Response> {
  const account = await accounts.forCaller(caller);
  const link = new URL(await account.connectUrl());
  return get(
    accounts,
    `/oauth/callback?code=moneybird-code&state=${link.searchParams.get('ticket') ?? ''}`,
  );
}

describe('callerFrom', () => {
  it('reads the user and email Airlock forwards', () => {
    const request = new Request(LOCAL, {
      headers: { 'x-airlock-user': 'user-1', 'x-airlock-email': 'souf@example.com' },
    });
    expect(callerFrom(request)).toEqual(CALLER);
  });

  it('is undefined without a user', () => {
    expect(callerFrom(new Request(LOCAL))).toBeUndefined();
  });
});

describe('AirlockAccounts', () => {
  it('hands out a public connect link that names the account', async () => {
    const { accounts } = build();
    const account = await accounts.forCaller(CALLER);

    const link = new URL(await account.connectUrl());
    expect(`${link.origin}${link.pathname}`).toBe(`${PUBLIC_URL}/connect`);

    const page = await get(accounts, `/connect${link.search}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('souf@example.com');

    const authorize = new URL(/href="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&') ?? '');
    expect(authorize.origin).toBe('https://moneybird.com');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/oauth/callback`);
    expect(authorize.searchParams.get('state')).toBe(link.searchParams.get('ticket'));
  });

  it('stores the authorization under the user who asked for the link', async () => {
    const { accounts, stub } = build();

    const response = await connect(accounts);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Studio Souf');
    expect(stub.calls).toContain('POST https://moneybird.com/oauth/token');

    const account = await accounts.forCaller(CALLER);
    expect(account.administrations.map((entry) => entry.administrationId)).toEqual([
      '391695781953799753',
    ]);
    expect(account.defaultAdministrationId).toBe('391695781953799753');
    await expect(account.getToken()).resolves.toBe('mb-access-1');

    const stranger = await accounts.forCaller({ userId: 'user-2', email: undefined });
    expect(stranger.administrations).toEqual([]);
  });

  it('spends a ticket once', async () => {
    const { accounts } = build();
    const account = await accounts.forCaller(CALLER);
    const ticket = new URL(await account.connectUrl()).searchParams.get('ticket') ?? '';

    const first = await get(accounts, `/oauth/callback?code=a&state=${ticket}`);
    expect(first.status).toBe(200);

    const replay = await get(accounts, `/oauth/callback?code=b&state=${ticket}`);
    expect(replay.status).toBe(400);
    expect((await get(accounts, `/connect?ticket=${ticket}`)).status).toBe(400);
  });

  it('refuses an expired or unknown ticket', async () => {
    let now = Date.now();
    const { accounts } = build({}, () => now);
    const account = await accounts.forCaller(CALLER);
    const ticket = new URL(await account.connectUrl()).searchParams.get('ticket') ?? '';

    now += 11 * 60 * 1000;
    expect((await get(accounts, `/connect?ticket=${ticket}`)).status).toBe(400);
    expect((await get(accounts, `/oauth/callback?code=a&state=${ticket}`)).status).toBe(400);
    expect((await get(accounts, '/connect?ticket=made-up')).status).toBe(400);
  });

  it('shows the error Moneybird returns', async () => {
    const { accounts } = build();
    const response = await get(accounts, '/oauth/callback?error=access_denied');
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('access_denied');
  });

  it('keeps one connection per administration and needs an id once there are several', async () => {
    const { accounts, store } = build({
      administrations: [{ id: '1', name: 'Studio Souf' }],
    });
    await connect(accounts);
    store.administrations.push({
      userId: CALLER.userId,
      administrationId: '2',
      name: 'UltimateLemon',
      connectionId: store.administrations[0]?.connectionId ?? '',
    });

    const account = await accounts.forCaller(CALLER);
    expect(account.defaultAdministrationId).toBeUndefined();
    await expect(account.getToken('2')).resolves.toBe('mb-access-1');
    await expect(account.getToken('3')).rejects.toBeInstanceOf(MissingCredentialsError);

    await expect(account.disconnect('1')).resolves.toBe(true);
    await expect(account.disconnect('1')).resolves.toBe(false);
  });

  it('asks to connect when nothing is connected', async () => {
    const { accounts } = build();
    const account = await accounts.forCaller(CALLER);
    await expect(account.getToken()).rejects.toThrow(/connect_moneybird/);
  });

  it('refreshes an expiring token once for concurrent calls', async () => {
    const { accounts, stub } = build({ expiresIn: 60 });
    await connect(accounts);

    const account = await accounts.forCaller(CALLER);
    const tokens = await Promise.all([account.getToken(), account.getToken()]);
    expect(tokens).toEqual(['mb-access-2', 'mb-access-2']);
    expect(stub.calls.filter((call) => call.endsWith('/oauth/token'))).toHaveLength(2);
  });

  it('leaves other paths and methods alone', async () => {
    const { accounts } = build();
    expect(await accounts.handle(new Request(LOCAL))).toBeUndefined();
    expect(await accounts.handle(new Request(`${LOCAL}/other`))).toBeUndefined();
    expect(
      await accounts.handle(new Request(`${LOCAL}/connect`, { method: 'POST' })),
    ).toBeUndefined();
  });
});
