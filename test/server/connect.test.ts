import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMoneybirdServer } from '../../src/server/create.js';
import { FileCredentialStore } from '../../src/config/store.js';
import { configFromEnv } from '../../src/config/schema.js';
import { stubFetch, type StubResponse } from '../support/fetch.js';

const ADMINISTRATIONS = [{ id: '456', name: 'Studio Souf', country: 'NL' }];

describe('connecting from inside the conversation', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'moneybird-mcp-connect-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  interface ElicitationParams {
    mode: string;
    message: string;
    url?: string;
  }

  /**
   * Builds a client that answers elicitation the way a real one would, so the connect flow is
   * exercised over the wire rather than by calling the handler directly.
   */
  async function harness(
    responses: StubResponse | StubResponse[],
    options: { elicitation?: { form?: boolean; url?: boolean }; token?: string } = {},
  ) {
    const http = stubFetch(responses);
    const store = new FileCredentialStore(join(dir, 'credentials.json'));

    const { server, session } = await createMoneybirdServer({
      config: configFromEnv({}),
      store,
      fetch: http.fetch,
      version: '0.0.0-test',
    });

    const capabilities = options.elicitation
      ? {
          elicitation: {
            ...(options.elicitation.form ? { form: {} } : {}),
            ...(options.elicitation.url ? { url: {} } : {}),
          },
        }
      : undefined;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'test', version: '0.0.0' },
      capabilities ? { capabilities } : undefined,
    );

    const elicited: ElicitationParams[] = [];
    if (capabilities) {
      client.setRequestHandler('elicitation/create', async (request) => {
        const params = request.params as ElicitationParams;
        elicited.push(params);
        if (params.mode === 'url') return { action: 'accept' };
        return { action: 'accept', content: { token: options.token ?? 'token-from-elicitation' } };
      });
    }

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    return {
      client,
      http,
      session,
      store,
      elicited,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  it('starts without credentials instead of failing', async () => {
    const h = await harness({ body: ADMINISTRATIONS });
    try {
      expect(h.session.isAuthenticated).toBe(false);
      const names = (await h.client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('connect_moneybird');
      expect(names).toContain('moneybird_connection_status');
    } finally {
      await h.close();
    }
  });

  it('reports that it is not connected', async () => {
    const h = await harness({ body: ADMINISTRATIONS });
    try {
      const result = await h.client.callTool({
        name: 'moneybird_connection_status',
        arguments: {},
      });
      const text = JSON.stringify(result);
      expect(text).toContain('Not connected');
      expect(h.http.requests).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('stores a token passed directly and starts using it', async () => {
    const h = await harness([{ body: ADMINISTRATIONS }, { body: [] }]);
    try {
      const result = await h.client.callTool({
        name: 'connect_moneybird',
        arguments: { token: 'pasted-token' },
      });

      expect(JSON.stringify(result)).toContain('Connected to Moneybird');
      expect(h.session.isAuthenticated).toBe(true);
      expect(h.session.administrationId).toBe('456');

      const stored = await h.store.read();
      expect(stored?.accessToken).toBe('pasted-token');

      await h.client.callTool({ name: 'list_contacts', arguments: {} });
      const last = h.http.requests.at(-1);
      expect(last?.url).toContain('/456/contacts.json');
      expect(last?.headers['authorization']).toBe('Bearer pasted-token');
    } finally {
      await h.close();
    }
  });

  it('tells a client that cannot prompt to use the CLI instead', async () => {
    const h = await harness({ body: ADMINISTRATIONS });
    try {
      const result = await h.client.callTool({ name: 'connect_moneybird', arguments: {} });
      const text = JSON.stringify(result);

      expect(text).toContain('cannot prompt');
      expect(text).toContain('moneybird-mcp login');
      expect(text).toContain('moneybird.com/user/applications/new');
    } finally {
      await h.close();
    }
  });

  it('opens Moneybird and collects the token when the client supports both modes', async () => {
    const h = await harness([{ body: ADMINISTRATIONS }, { body: ADMINISTRATIONS }], {
      elicitation: { form: true, url: true },
      token: 'elicited-token',
    });
    try {
      const result = await h.client.callTool({ name: 'connect_moneybird', arguments: {} });

      expect(h.elicited.map((entry) => entry.mode)).toEqual(['url', 'form']);
      expect(h.elicited[0]?.url).toBe('https://moneybird.com/user/applications/new');
      expect(JSON.stringify(result)).toContain('Connected to Moneybird');

      expect(h.session.isAuthenticated).toBe(true);
      expect((await h.store.read())?.accessToken).toBe('elicited-token');
    } finally {
      await h.close();
    }
  });

  it('puts the token page link in the prompt when the client cannot open URLs', async () => {
    const h = await harness([{ body: ADMINISTRATIONS }, { body: ADMINISTRATIONS }], {
      elicitation: { form: true },
    });
    try {
      await h.client.callTool({ name: 'connect_moneybird', arguments: {} });

      expect(h.elicited.map((entry) => entry.mode)).toEqual(['form']);
      expect(h.elicited[0]?.message).toContain('moneybird.com/user/applications/new');
      expect(h.session.isAuthenticated).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('rejects an administration the token cannot reach', async () => {
    const h = await harness([{ body: ADMINISTRATIONS }, { body: ADMINISTRATIONS }]);
    try {
      await h.client.callTool({ name: 'connect_moneybird', arguments: { token: 'pasted-token' } });
      const result = await h.client.callTool({
        name: 'select_administration',
        arguments: { administration_id: '999' },
      });

      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(JSON.stringify(result)).toContain('not reachable');
    } finally {
      await h.close();
    }
  });
});
