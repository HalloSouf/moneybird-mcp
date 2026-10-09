import { McpServer } from '@modelcontextprotocol/server';
import type { ServerConfig } from '../config/schema.js';
import { permissionsFor } from '../config/schema.js';
import type { CredentialStore } from '../config/store.js';
import { FileCredentialStore } from '../config/store.js';
import { AuthSession } from '../auth/session.js';
import type { UserAccount } from '../auth/airlock.js';
import { MoneybirdClient, type MoneybirdClientOptions } from '../moneybird/client.js';
import { allTools } from '../tools/index.js';
import { accountTools } from '../tools/account.js';
import { connectTools } from '../tools/connect.js';
import { registerTools, type RegistrationSummary } from '../tools/registry.js';
import type { ToolDefinition } from '../tools/common.js';

export const SERVER_NAME = 'moneybird';

export interface CreateServerOptions {
  config: ServerConfig;
  store?: CredentialStore;
  /** The Airlock user this request acts for; replaces the local credential store. */
  account?: UserAccount;
  /** Overrides the built-in tool set; used by tests. */
  tools?: readonly ToolDefinition[];
  version?: string;
  fetch?: typeof globalThis.fetch;
}

export interface CreatedServer {
  server: McpServer;
  client: MoneybirdClient;
  /** Undefined when the server acts for an Airlock user. */
  session: AuthSession | undefined;
  registration: RegistrationSummary;
}

function administrationLine(config: ServerConfig, account: UserAccount | undefined): string {
  if (account) {
    if (account.administrations.length === 0) {
      return 'No administration is connected yet — call connect_moneybird first.';
    }
    const list = account.administrations
      .map((entry) => `${entry.name} (${entry.administrationId})`)
      .join(', ');
    return account.defaultAdministrationId
      ? `Connected administration: ${list}. Call connect_moneybird to add another.`
      : `Connected administrations: ${list}. Pass administration_id on every call.`;
  }
  return config.administrationId
    ? `Default administration: ${config.administrationId}. This is only a default: every ` +
        'administration the credential can reach is still available, so pass administration_id ' +
        'to act on another one, and call list_administrations to see them.'
    : 'No default administration is configured — call list_administrations first and pass administration_id.';
}

function instructionsFor(config: ServerConfig, account: UserAccount | undefined): string {
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
    administrationLine(config, account),
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
  const { config, account } = options;

  let session: AuthSession | undefined;
  let credentials: Pick<MoneybirdClientOptions, 'token' | 'administrationId'>;
  if (account) {
    credentials = { token: account.getToken, administrationId: account.defaultAdministrationId };
  } else {
    const local = await AuthSession.create({
      config,
      store: options.store ?? new FileCredentialStore(),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    session = local;
    credentials = { token: local.getToken, administrationId: () => local.administrationId };
  }

  const client = new MoneybirdClient({
    ...credentials,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.timeZone ? { timeZone: config.timeZone } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    maxRetries: config.maxRetries,
    requestTimeoutMs: config.requestTimeoutMs,
    userAgent: `moneybird-mcp/${options.version ?? '0.0.0'}`,
  });

  const server = new McpServer(
    { name: SERVER_NAME, version: options.version ?? '0.0.0' },
    { instructions: instructionsFor(config, account) },
  );

  const context = { client, config };

  // The connect tools bypass toolset and permission gating: they are the way out of a server that
  // has no working credentials, so hiding them would leave the user with no in-band recovery.
  const elicitation = () => {
    const capability = server.server.getClientCapabilities()?.elicitation;
    return { form: capability?.form !== undefined, url: capability?.url !== undefined };
  };
  const setupTools = session
    ? connectTools(session, elicitation)
    : accountTools(account as UserAccount, elicitation);
  const registration = registerTools({
    server,
    definitions: [...setupTools, ...(options.tools ?? allTools)],
    config,
    context,
    always: new Set(setupTools.map((tool) => tool.name)),
  });

  return { server, client, session, registration };
}
