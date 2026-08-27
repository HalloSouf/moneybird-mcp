import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { registerTools, toToolError } from '../../src/tools/registry.js';
import type { ToolContext, ToolDefinition } from '../../src/tools/common.js';
import type { ServerConfig } from '../../src/config/schema.js';
import {
  MoneybirdAuthError,
  MoneybirdError,
  MoneybirdNotFoundError,
  MoneybirdRateLimitError,
  MoneybirdValidationError,
} from '../../src/moneybird/errors.js';

function definition(
  overrides: Partial<ToolDefinition> & Pick<ToolDefinition, 'name' | 'toolset' | 'access'>,
): ToolDefinition {
  return {
    title: overrides.name,
    description: 'a test tool',
    inputSchema: z.object({}),
    handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    ...overrides,
  };
}

function fakeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    toolsets: ['core'],
    allowWrite: false,
    allowDelete: false,
    transport: 'stdio',
    host: '127.0.0.1',
    port: 3000,
    requestTimeoutMs: 30_000,
    maxRetries: 3,
    ...overrides,
  } as ServerConfig;
}

function fakeServer() {
  const registered = new Map<string, unknown>();
  const server = {
    registerTool: (name: string, meta: unknown, handler: unknown) => {
      registered.set(name, { meta, handler });
    },
  } as unknown as McpServer;
  return { server, registered };
}

describe('registerTools toolset filtering', () => {
  it('registers only tools whose toolset is enabled', () => {
    const definitions = [
      definition({ name: 'list_contacts', toolset: 'core', access: 'read' }),
      definition({ name: 'list_bank_transactions', toolset: 'banking', access: 'read' }),
    ];
    const { server, registered } = fakeServer();

    const summary = registerTools({
      server,
      definitions,
      config: fakeConfig({ toolsets: ['core'] }),
      context: {} as ToolContext,
    });

    expect(summary.registered).toEqual(['list_contacts']);
    expect(summary.skippedByToolset).toEqual(['list_bank_transactions']);
    expect(registered.has('list_contacts')).toBe(true);
    expect(registered.has('list_bank_transactions')).toBe(false);
  });
});

describe('registerTools permission filtering', () => {
  const definitions = [
    definition({ name: 'list_contacts', toolset: 'core', access: 'read' }),
    definition({ name: 'create_contact', toolset: 'core', access: 'write' }),
    definition({ name: 'delete_contact', toolset: 'core', access: 'destroy' }),
  ];

  it('registers only read tools with no permissions granted', () => {
    const { server } = fakeServer();
    const summary = registerTools({
      server,
      definitions,
      config: fakeConfig(),
      context: {} as ToolContext,
    });

    expect(summary.registered).toEqual(['list_contacts']);
    expect(summary.skippedByPermission).toEqual(['create_contact', 'delete_contact']);
  });

  it('registers write tools once allowWrite is set, but still skips destroy', () => {
    const { server } = fakeServer();
    const summary = registerTools({
      server,
      definitions,
      config: fakeConfig({ allowWrite: true }),
      context: {} as ToolContext,
    });

    expect(summary.registered).toEqual(['list_contacts', 'create_contact']);
    expect(summary.skippedByPermission).toEqual(['delete_contact']);
  });

  it('registers destroy tools only once both allowWrite and allowDelete are set', () => {
    const { server } = fakeServer();
    const summary = registerTools({
      server,
      definitions,
      config: fakeConfig({ allowWrite: true, allowDelete: true }),
      context: {} as ToolContext,
    });

    expect(summary.registered).toEqual(['list_contacts', 'create_contact', 'delete_contact']);
    expect(summary.skippedByPermission).toEqual([]);
  });

  it('does not grant destroy from allowDelete alone', () => {
    const { server } = fakeServer();
    const summary = registerTools({
      server,
      definitions,
      config: fakeConfig({ allowDelete: true }),
      context: {} as ToolContext,
    });

    expect(summary.registered).toEqual(['list_contacts']);
    expect(summary.skippedByPermission).toEqual(['create_contact', 'delete_contact']);
  });
});

describe('toToolError', () => {
  function errorOf(
    status: number,
    options: Partial<ConstructorParameters<typeof MoneybirdError>[1]> = {},
  ) {
    return { method: 'GET', url: 'https://example.test', status, ...options };
  }

  it('renders a MoneybirdValidationError with per-field messages', () => {
    const error = new MoneybirdValidationError("can't be blank", {
      ...errorOf(422),
      validation: { company_name: ["can't be blank"] },
    });
    const result = toToolError(error);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('company_name');
  });

  it('renders a MoneybirdAuthError pointing at re-authenticating', () => {
    const error = new MoneybirdAuthError('Invalid token', errorOf(401));
    const result = toToolError(error);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('moneybird-mcp login');
  });

  it('renders a MoneybirdRateLimitError with the retry wait when known', () => {
    const error = new MoneybirdRateLimitError('slow down', {
      ...errorOf(429),
      retryAfterSeconds: 5,
    });
    const result = toToolError(error);
    expect((result.content[0] as { text: string }).text).toContain('Retry in 5s');
  });

  it('renders a MoneybirdRateLimitError without a wait when unknown', () => {
    const error = new MoneybirdRateLimitError('slow down', errorOf(429));
    const result = toToolError(error);
    expect((result.content[0] as { text: string }).text).not.toContain('Retry in');
  });

  it('renders a MoneybirdNotFoundError (a generic MoneybirdError) with its status', () => {
    const error = new MoneybirdNotFoundError('Not found', errorOf(404));
    const result = toToolError(error);
    expect((result.content[0] as { text: string }).text).toContain('404');
  });

  it('renders a plain Error using its message', () => {
    const result = toToolError(new Error('boom'));
    expect((result.content[0] as { text: string }).text).toBe('boom');
  });

  it('renders a non-Error throwable via String()', () => {
    const result = toToolError('just a string');
    expect((result.content[0] as { text: string }).text).toBe('just a string');
  });
});
