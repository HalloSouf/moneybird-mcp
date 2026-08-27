import { describe, expect, it, vi } from 'vitest';
import { MoneybirdClient } from '../../src/moneybird/client.js';
import {
  MoneybirdAuthError,
  MoneybirdError,
  MoneybirdNetworkError,
  MoneybirdNotFoundError,
  MoneybirdRateLimitError,
  MoneybirdValidationError,
} from '../../src/moneybird/errors.js';
import { stubFetch, instantSleep, type StubResponse } from '../support/fetch.js';

function makeClient(
  overrides: Partial<ConstructorParameters<typeof MoneybirdClient>[0]> & {
    responses: StubResponse | StubResponse[];
  },
) {
  const { responses, ...options } = overrides;
  const http = stubFetch(responses);
  const client = new MoneybirdClient({
    token: 'static-token',
    administrationId: '123',
    fetch: http.fetch,
    sleep: instantSleep,
    random: () => 0,
    ...options,
  });
  return { client, http };
}

describe('MoneybirdClient.buildUrl', () => {
  it('appends the .json suffix and prefixes the administration id', () => {
    const { client } = makeClient({ responses: { body: [] } });
    expect(client.buildUrl({ path: 'contacts' })).toBe(
      'https://moneybird.com/api/v2/123/contacts.json',
    );
  });

  it('strips a leading slash from the path', () => {
    const { client } = makeClient({ responses: { body: [] } });
    expect(client.buildUrl({ path: '/contacts' })).toBe(
      'https://moneybird.com/api/v2/123/contacts.json',
    );
  });

  it('omits the administration when administrationScoped is false', () => {
    const { client } = makeClient({ responses: { body: [] } });
    expect(client.buildUrl({ path: 'administrations', administrationScoped: false })).toBe(
      'https://moneybird.com/api/v2/administrations.json',
    );
  });

  it('encodes query parameters and drops undefined ones', () => {
    const { client } = makeClient({ responses: { body: [] } });
    const url = client.buildUrl({
      path: 'contacts',
      query: { filter: 'contact_type:company', page: 2, per_page: undefined },
    });
    expect(url).toBe(
      'https://moneybird.com/api/v2/123/contacts.json?filter=contact_type%3Acompany&page=2',
    );
  });

  it('throws a clear error when no administration is configured', () => {
    const { client } = makeClient({ responses: { body: [] }, administrationId: undefined });
    expect(() => client.buildUrl({ path: 'contacts' })).toThrow(/No administration selected/);
  });
});

describe('MoneybirdClient auth', () => {
  it('sends a static token as a bearer header', async () => {
    const { client, http } = makeClient({ responses: { body: [] } });
    await client.get('contacts');
    expect(http.lastRequest().headers['authorization']).toBe('Bearer static-token');
  });

  it('awaits an async TokenProvider for every request', async () => {
    let call = 0;
    const provider = vi.fn(async () => `token-${++call}`);
    const { client, http } = makeClient({
      responses: [{ body: [] }, { body: [] }],
      token: provider,
    });

    await client.get('contacts');
    await client.get('contacts');

    expect(provider).toHaveBeenCalledTimes(2);
    expect(http.requests[0]?.headers['authorization']).toBe('Bearer token-1');
    expect(http.requests[1]?.headers['authorization']).toBe('Bearer token-2');
  });
});

describe('MoneybirdClient timeZone', () => {
  it('sets the Time-Zone header when configured', async () => {
    const { client, http } = makeClient({ responses: { body: [] }, timeZone: 'Europe/Amsterdam' });
    await client.get('contacts');
    expect(http.lastRequest().headers['time-zone']).toBe('Europe/Amsterdam');
  });

  it('omits the Time-Zone header when unset', async () => {
    const { client, http } = makeClient({ responses: { body: [] } });
    await client.get('contacts');
    expect(http.lastRequest().headers['time-zone']).toBeUndefined();
  });
});

describe('MoneybirdClient retries', () => {
  it('retries a 429 and returns the eventual success', async () => {
    const { client, http } = makeClient({
      responses: [{ status: 429, body: { error: 'Rate limit exceeded' } }, { body: { id: '1' } }],
      maxRetries: 3,
    });
    const response = await client.get('contacts');
    expect(response.data).toEqual({ id: '1' });
    expect(http.requests).toHaveLength(2);
  });

  it('retries a 500 and returns the eventual success', async () => {
    const { client, http } = makeClient({
      responses: [{ status: 500, body: { error: 'boom' } }, { body: { id: '1' } }],
      maxRetries: 3,
    });
    const response = await client.get('contacts');
    expect(response.data).toEqual({ id: '1' });
    expect(http.requests).toHaveLength(2);
  });

  it('does not retry a non-429 4xx status', async () => {
    const { client, http } = makeClient({
      responses: [{ status: 404, body: { error: 'Not found' } }, { body: { id: '1' } }],
      maxRetries: 3,
    });
    await expect(client.get('contacts')).rejects.toBeInstanceOf(MoneybirdNotFoundError);
    expect(http.requests).toHaveLength(1);
  });

  it('stops after maxRetries attempts and throws the last error', async () => {
    const { client, http } = makeClient({
      responses: { status: 500, body: { error: 'boom' } },
      maxRetries: 2,
    });
    await expect(client.get('contacts')).rejects.toMatchObject({ status: 500 });
    expect(http.requests).toHaveLength(3);
  });

  it('honours Retry-After over exponential backoff', async () => {
    const sleep = vi.fn(instantSleep);
    const { client } = makeClient({
      responses: [
        { status: 429, body: { error: 'slow down' }, headers: { 'retry-after': '2' } },
        { body: { id: '1' } },
      ],
      maxRetries: 3,
      sleep,
    });

    await client.get('contacts');

    expect(sleep).toHaveBeenCalledWith(2000);
  });
});

describe('MoneybirdClient manual redirects', () => {
  it('returns the Location header as redirectUrl without following it', async () => {
    const { client, http } = makeClient({
      responses: {
        status: 302,
        body: '',
        headers: { location: 'https://moneybird.com/files/short-lived-url' },
      },
    });

    const response = await client.get('sales_invoices/1/download_pdf', { manualRedirect: true });

    expect(response.redirectUrl).toBe('https://moneybird.com/files/short-lived-url');
    expect(http.requests).toHaveLength(1);
  });
});

describe('MoneybirdClient response bodies', () => {
  it('yields null for a 204 response', async () => {
    const { client } = makeClient({ responses: { status: 204 } });
    const response = await client.get('contacts/1');
    expect(response.data).toBeNull();
  });

  it('yields null for an empty body', async () => {
    const { client } = makeClient({ responses: { status: 200, body: '' } });
    const response = await client.get('contacts/1');
    expect(response.data).toBeNull();
  });

  it('yields raw text for a non-JSON content type', async () => {
    const { client } = makeClient({
      responses: { status: 200, body: 'plain text body', headers: { 'content-type': 'text/csv' } },
    });
    const response = await client.get('contacts/1');
    expect(response.data).toBe('plain text body');
  });

  it('does not throw on malformed JSON, returning it as raw text', async () => {
    const { client } = makeClient({
      responses: {
        status: 200,
        body: '{not valid json',
        headers: { 'content-type': 'application/json' },
      },
    });
    const response = await client.get('contacts/1');
    expect(response.data).toBe('{not valid json');
  });
});

describe('MoneybirdClient error mapping', () => {
  it.each([
    [401, MoneybirdAuthError],
    [403, MoneybirdAuthError],
    [404, MoneybirdNotFoundError],
    [422, MoneybirdValidationError],
    [429, MoneybirdRateLimitError],
  ])('maps status %d onto %s', async (status, errorClass) => {
    const { client } = makeClient({
      responses: { status, body: { error: 'failure' } },
      maxRetries: 0,
    });
    await expect(client.get('contacts')).rejects.toBeInstanceOf(errorClass);
  });

  it('maps a transport failure onto MoneybirdNetworkError', async () => {
    const { client } = makeClient({
      responses: { throws: new Error('socket hang up') },
      maxRetries: 0,
    });
    const error = await client.get('contacts').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MoneybirdNetworkError);
    expect((error as MoneybirdError).message).toContain('socket hang up');
  });

  it('produces the timeout message when the underlying fetch times out', async () => {
    const timeoutError = Object.assign(new Error('The operation was aborted'), {
      name: 'TimeoutError',
    });
    const { client } = makeClient({
      responses: { throws: timeoutError },
      maxRetries: 0,
      requestTimeoutMs: 5000,
    });
    const error = await client.get('contacts').catch((err: unknown) => err);
    expect((error as MoneybirdError).message).toBe('Request timed out after 5000ms');
  });
});
