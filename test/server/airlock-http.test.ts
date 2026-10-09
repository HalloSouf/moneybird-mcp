import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AirlockAccounts } from '../../src/auth/airlock.js';
import { configFromEnv } from '../../src/config/schema.js';
import { serveHttp, type HttpHandle } from '../../src/server/http.js';
import { MemoryConnectionStore } from '../support/memory-connections.js';

describe('the airlock HTTP mode', () => {
  let handle: HttpHandle | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await handle?.close();
    client = undefined;
    handle = undefined;
  });

  async function start(): Promise<{ url: string; store: MemoryConnectionStore }> {
    const store = new MemoryConnectionStore();
    const accounts = new AirlockAccounts({
      store,
      publicUrl: 'https://mcp.example.com/moneybird',
      endpoint: '/mcp',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      scopes: ['sales_invoices'],
    });
    handle = await serveHttp({
      config: { ...configFromEnv({}), port: 0 },
      authMode: 'airlock',
      accounts,
      version: '0.0.0-test',
    });
    return { url: handle.url, store };
  }

  it('rejects a request that did not come through Airlock', async () => {
    const { url } = await start();
    const response = await fetch(url, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
  });

  it('serves the connect page without a user', async () => {
    const { url } = await start();
    const response = await fetch(`${url}/connect?ticket=unknown`);
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('gives an Airlock user the account tools and a link bound to them', async () => {
    const { url, store } = await start();
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { 'x-airlock-user': 'user-1', 'x-airlock-email': 'a@b.nl' } },
      }),
    );

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('connect_moneybird');
    expect(names).toContain('disconnect_moneybird');
    expect(names).not.toContain('select_administration');

    const result = await client.callTool({ name: 'connect_moneybird', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('https://mcp.example.com/moneybird/connect?ticket=');
    expect(store.tickets).toHaveLength(1);
    expect(store.tickets[0]?.userId).toBe('user-1');
    expect(store.tickets[0]?.email).toBe('a@b.nl');
  });
});
