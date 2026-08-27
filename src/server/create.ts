import { McpServer } from '@modelcontextprotocol/server';
import type { ServerConfig } from '../config/schema.js';
import { permissionsFor } from '../config/schema.js';
import type { CredentialStore } from '../config/store.js';
import { FileCredentialStore } from '../config/store.js';
import { AuthSession } from '../auth/session.js';
import { MoneybirdClient } from '../moneybird/client.js';
import { allTools } from '../tools/index.js';
import { connectTools } from '../tools/connect.js';
import { registerTools, type RegistrationSummary } from '../tools/registry.js';
import type { ToolDefinition } from '../tools/common.js';

export const SERVER_NAME = 'moneybird';

export interface CreateServerOptions {
  config: ServerConfig;
  store?: CredentialStore;
  /** Overrides the built-in tool set; used by tests. */
  tools?: readonly ToolDefinition[];
  version?: string;
  fetch?: typeof globalThis.fetch;
}

export interface CreatedServer {
  server: McpServer;
  client: MoneybirdClient;
  session: AuthSession;
  registration: RegistrationSummary;
}

function instructionsFor(config: ServerConfig): string {
  const permissions = permissionsFor(config);
  const mode = permissions.destroy
    ? 'read, write and delete'
    : permissions.write
      ? 'read and write (deleting is disabled)'
      : 'read-only';

  return [
    'Tools for the Moneybird accounting API.',
    '',
    `Enabled toolsets: ${config.toolsets.join(', ')}. Access: ${mode}.`,
    config.administrationId
      ? `Default administration: ${config.administrationId}.`
      : 'No default administration is configured — call list_administrations first and pass administration_id.',
    '',
    'Amounts are decimal strings and follow the administration currency. Dates are ISO 8601.',
    'Moneybird allows 150 requests per 5 minutes per IP (50 for reports), so prefer filters over ' +
      'paging through entire collections.',
  ].join('\n');
}

/**
 * Builds the MCP server and the Moneybird client behind it.
 *
 * Credentials are resolved once at startup so a misconfigured deployment fails immediately
 * rather than on the first tool call.
 */
export async function createMoneybirdServer(options: CreateServerOptions): Promise<CreatedServer> {
  const { config } = options;
  const store = options.store ?? new FileCredentialStore();

  const session = await AuthSession.create({
    config,
    store,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const client = new MoneybirdClient({
    token: session.getToken,
    administrationId: () => session.administrationId,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.timeZone ? { timeZone: config.timeZone } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    maxRetries: config.maxRetries,
    requestTimeoutMs: config.requestTimeoutMs,
    userAgent: `moneybird-mcp/${options.version ?? '0.0.0'}`,
  });

  const server = new McpServer(
    { name: SERVER_NAME, version: options.version ?? '0.0.0' },
    { instructions: instructionsFor(config) },
  );

  const context = { client, config };

  // The connect tools bypass toolset and permission gating: they are the way out of a server that
  // has no working credentials, so hiding them would leave the user with no in-band recovery.
  const setupTools = connectTools(session, () => {
    const elicitation = server.server.getClientCapabilities()?.elicitation;
    return { form: elicitation?.form !== undefined, url: elicitation?.url !== undefined };
  });
  const registration = registerTools({
    server,
    definitions: [...setupTools, ...(options.tools ?? allTools)],
    config,
    context,
    always: new Set(setupTools.map((tool) => tool.name)),
  });

  return { server, client, session, registration };
}
