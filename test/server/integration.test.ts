import { describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMoneybirdServer } from '../../src/server/create.js';
import { MemoryCredentialStore } from '../../src/config/store.js';
import { configFromEnv } from '../../src/config/schema.js';
import { stubFetch, type FetchStub } from '../support/fetch.js';

interface Harness {
  client: Client;
  http: FetchStub;
  close(): Promise<void>;
}

async function connect(
  env: Record<string, string>,
  responses: Parameters<typeof stubFetch>[0],
): Promise<Harness> {
  const http = stubFetch(responses);
  const config = configFromEnv({ MONEYBIRD_API_TOKEN: 'test-token', ...env });

  const { server } = await createMoneybirdServer({
    config,
    store: new MemoryCredentialStore(),
    fetch: http.fetch,
    version: '0.0.0-test',
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    http,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content
    .filter((entry) => entry.type === 'text')
    .map((entry) => entry.text ?? '')
    .join('\n');
}

describe('server over the MCP protocol', () => {
  it('lists only read tools by default', async () => {
    const harness = await connect({ MONEYBIRD_ADMINISTRATION_ID: '123' }, { body: [] });
    try {
      const { tools } = await harness.client.listTools();
      const names = tools.map((tool) => tool.name);

      expect(names).toContain('list_contacts');
      expect(names).not.toContain('create_contact');
      expect(names).not.toContain('delete_contact');
    } finally {
      await harness.close();
    }
  });

  it('exposes write tools once write access is enabled, but still hides deletes', async () => {
    const harness = await connect(
      { MONEYBIRD_ADMINISTRATION_ID: '123', MONEYBIRD_ALLOW_WRITE: 'true' },
      { body: [] },
    );
    try {
      const names = (await harness.client.listTools()).tools.map((tool) => tool.name);

      expect(names).toContain('create_contact');
      expect(names).not.toContain('delete_contact');
    } finally {
      await harness.close();
    }
  });

  it('marks read tools as read-only and deletes as destructive', async () => {
    const harness = await connect(
      {
        MONEYBIRD_ADMINISTRATION_ID: '123',
        MONEYBIRD_ALLOW_WRITE: 'true',
        MONEYBIRD_ALLOW_DELETE: 'true',
      },
      { body: [] },
    );
    try {
      const { tools } = await harness.client.listTools();
      const list = tools.find((tool) => tool.name === 'list_contacts');
      const remove = tools.find((tool) => tool.name === 'delete_contact');

      expect(list?.annotations?.readOnlyHint).toBe(true);
      expect(remove?.annotations?.destructiveHint).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('calls Moneybird with the configured administration and returns the payload', async () => {
    const harness = await connect(
      { MONEYBIRD_ADMINISTRATION_ID: '123' },
      { body: [{ id: '1', company_name: 'Acme BV' }] },
    );
    try {
      const result = await harness.client.callTool({
        name: 'list_contacts',
        arguments: { per_page: 10 },
      });

      const request = harness.http.lastRequest();
      expect(request.url).toBe('https://moneybird.com/api/v2/123/contacts.json?per_page=10');
      expect(request.headers['authorization']).toBe('Bearer test-token');
      expect(textOf(result)).toContain('Acme BV');
    } finally {
      await harness.close();
    }
  });

  it('routes a filtered contact search to the filter endpoint', async () => {
    const harness = await connect({ MONEYBIRD_ADMINISTRATION_ID: '123' }, { body: [] });
    try {
      await harness.client.callTool({
        name: 'list_contacts',
        arguments: { filter: 'contact_type:company' },
      });

      expect(harness.http.lastRequest().url).toContain('/contacts/filter.json');
      expect(harness.http.lastRequest().url).toContain('filter=contact_type%3Acompany');
    } finally {
      await harness.close();
    }
  });

  it('reports a Moneybird validation failure as a tool error rather than a transport error', async () => {
    const harness = await connect(
      { MONEYBIRD_ADMINISTRATION_ID: '123', MONEYBIRD_ALLOW_WRITE: 'true' },
      { status: 422, body: { error: { company_name: ["can't be blank"] } } },
    );
    try {
      const result = await harness.client.callTool({
        name: 'create_contact',
        arguments: { contact: {} },
      });

      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toContain("company_name: can't be blank");
    } finally {
      await harness.close();
    }
  });

  it('rejects a tool that is not exposed', async () => {
    const harness = await connect({ MONEYBIRD_ADMINISTRATION_ID: '123' }, { body: [] });
    try {
      await expect(
        harness.client.callTool({ name: 'delete_contact', arguments: { contact_id: '1' } }),
      ).rejects.toThrow();
    } finally {
      await harness.close();
    }
  });
});
