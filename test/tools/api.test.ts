import { describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { accessFor, findOperation, loadOperations, searchOperations } from '../../src/tools/api.js';
import { createMoneybirdServer } from '../../src/server/create.js';
import { MemoryCredentialStore } from '../../src/config/store.js';
import { configFromEnv } from '../../src/config/schema.js';
import { stubFetch } from '../support/fetch.js';

describe('the endpoint catalogue', () => {
  it('matches filled-in paths against the spec, administration-scoped or not', async () => {
    const operations = await loadOperations();
    expect(findOperation(operations, 'GET', 'sales_invoices/123')?.path).toBe(
      'sales_invoices/{id}',
    );
    expect(findOperation(operations, 'GET', 'administrations')?.scoped).toBe(false);
    expect(findOperation(operations, 'PATCH', 'sales_invoices')).toBeUndefined();
    expect(findOperation(operations, 'GET', 'sales_invoices/../users')).toBeUndefined();
    expect(findOperation(operations, 'GET', 'made_up')).toBeUndefined();
  });

  it('finds endpoints by what they do', async () => {
    const found = searchOperations(await loadOperations(), 'profit loss report');
    expect(found[0]?.path).toBe('reports/profit_loss');
    expect(searchOperations(await loadOperations(), '?')).toEqual([]);
  });

  it('treats money, mail and deletes as irreversible', () => {
    expect(accessFor('GET', 'sales_invoices')).toBe('read');
    expect(accessFor('POST', 'contacts')).toBe('write');
    expect(accessFor('DELETE', 'contacts/{id}')).toBe('destroy');
    expect(accessFor('PATCH', 'sales_invoices/{id}/send_invoice')).toBe('destroy');
    expect(accessFor('POST', 'sales_invoices/{sales_invoice_id}/payments')).toBe('destroy');
    expect(accessFor('PATCH', 'financial_mutations/{id}/link_booking')).toBe('destroy');
  });
});

async function call(env: Record<string, string>, args: Record<string, unknown>) {
  const http = stubFetch({ body: { id: '9' } });
  const { server } = await createMoneybirdServer({
    config: configFromEnv({
      MONEYBIRD_API_TOKEN: 'test-token',
      MONEYBIRD_ADMINISTRATION_ID: '123',
      ...env,
    }),
    store: new MemoryCredentialStore(),
    fetch: http.fetch,
    version: '0.0.0-test',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.callTool({ name: 'moneybird_api', arguments: args });
  await client.close();
  return {
    http,
    isError: result.isError === true,
    text: (result.content as Array<{ text: string }>)[0]?.text ?? '',
  };
}

describe('moneybird_api', () => {
  it('calls the endpoint with query and body', async () => {
    const { http, isError } = await call(
      { MONEYBIRD_ALLOW_WRITE: 'true' },
      {
        method: 'POST',
        path: '/recurring_sales_invoices',
        query: { x: 1 },
        body: { recurring_sales_invoice: { contact_id: '1' } },
      },
    );
    expect(isError).toBe(false);
    const request = http.lastRequest();
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://moneybird.com/api/v2/123/recurring_sales_invoices.json?x=1');
    expect(request.body).toEqual({ recurring_sales_invoice: { contact_id: '1' } });
  });

  it('refuses writes on a read-only server', async () => {
    const { http, isError, text } = await call({}, { method: 'POST', path: 'contacts' });
    expect(isError).toBe(true);
    expect(text).toContain('MONEYBIRD_ALLOW_WRITE');
    expect(http.requests).toHaveLength(0);
  });

  it('refuses irreversible actions unless deleting is allowed', async () => {
    const { http, isError, text } = await call(
      { MONEYBIRD_ALLOW_WRITE: 'true' },
      { method: 'PATCH', path: 'sales_invoices/5/send_invoice' },
    );
    expect(isError).toBe(true);
    expect(text).toContain('MONEYBIRD_ALLOW_DELETE');
    expect(http.requests).toHaveLength(0);
  });

  it('refuses a path that is not in the spec', async () => {
    const { isError, text } = await call({}, { method: 'GET', path: 'secrets' });
    expect(isError).toBe(true);
    expect(text).toContain('find_moneybird_endpoint');
  });
});
