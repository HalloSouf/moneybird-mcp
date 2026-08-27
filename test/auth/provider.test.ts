import { describe, expect, it } from 'vitest';
import { MissingCredentialsError, resolveAuth } from '../../src/auth/provider.js';
import { MemoryCredentialStore, type StoredCredentials } from '../../src/config/store.js';
import { configFromEnv } from '../../src/config/schema.js';
import { stubFetch } from '../support/fetch.js';

const oauthCredentials: StoredCredentials = {
  version: 1,
  kind: 'oauth',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  clientId: 'client-1',
  clientSecret: 'secret-1',
  // Well within REFRESH_LEEWAY_SECONDS of the `now` used below, so it always counts as expiring.
  expiresAt: 1_000,
};

describe('resolveAuth', () => {
  it('prefers MONEYBIRD_API_TOKEN over a stored credential', async () => {
    const config = configFromEnv({ MONEYBIRD_API_TOKEN: 'env-token' });
    const store = new MemoryCredentialStore(oauthCredentials);

    const resolved = await resolveAuth({ config, store });

    expect(resolved.source).toBe('environment');
    expect(await resolved.getToken()).toBe('env-token');
  });

  it('returns a stored non-expiring token as-is', async () => {
    const config = configFromEnv({});
    const stored: StoredCredentials = {
      version: 1,
      kind: 'personal_access_token',
      accessToken: 'stored-token',
    };
    const store = new MemoryCredentialStore(stored);

    const resolved = await resolveAuth({ config, store });

    expect(resolved.source).toBe('stored');
    expect(await resolved.getToken()).toBe('stored-token');
  });

  it('refreshes an expiring OAuth token and writes the refreshed value back to the store', async () => {
    const config = configFromEnv({});
    const store = new MemoryCredentialStore({ ...oauthCredentials });
    const http = stubFetch({
      body: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 },
    });

    const resolved = await resolveAuth({
      config,
      store,
      fetch: http.fetch,
      now: () => 1_000 * 1000,
    });

    const token = await resolved.getToken();

    expect(token).toBe('access-2');
    expect(http.requests).toHaveLength(1);
    expect(await store.read()).toMatchObject({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
    });
  });

  it('triggers only one refresh for concurrent calls', async () => {
    const config = configFromEnv({});
    const store = new MemoryCredentialStore({ ...oauthCredentials });
    const http = stubFetch({ body: { access_token: 'access-2' } });

    const resolved = await resolveAuth({
      config,
      store,
      fetch: http.fetch,
      now: () => 1_000 * 1000,
    });

    const [first, second, third] = await Promise.all([
      resolved.getToken(),
      resolved.getToken(),
      resolved.getToken(),
    ]);

    expect(http.requests).toHaveLength(1);
    expect([first, second, third]).toEqual(['access-2', 'access-2', 'access-2']);
  });

  it('throws MissingCredentialsError when no credential is stored', async () => {
    const config = configFromEnv({});
    const store = new MemoryCredentialStore();

    await expect(resolveAuth({ config, store })).rejects.toBeInstanceOf(MissingCredentialsError);
  });

  it('throws MissingCredentialsError when an expired token cannot be refreshed', async () => {
    const config = configFromEnv({});
    const store = new MemoryCredentialStore({
      version: 1,
      kind: 'oauth',
      accessToken: 'access-1',
      expiresAt: 1_000,
    });

    const resolved = await resolveAuth({ config, store, now: () => 1_000 * 1000 });

    await expect(resolved.getToken()).rejects.toBeInstanceOf(MissingCredentialsError);
  });
});
