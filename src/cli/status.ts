import { permissionsFor, type ServerConfig } from '../config/schema.js';
import { FileCredentialStore, type CredentialStore } from '../config/store.js';
import { MoneybirdClient } from '../moneybird/client.js';
import { MoneybirdError } from '../moneybird/errors.js';
import { resolveAuth } from '../auth/provider.js';
import { allTools } from '../tools/index.js';
import { out } from './prompt.js';

export interface StatusOptions {
  config: ServerConfig;
  store?: CredentialStore;
  fetch?: typeof globalThis.fetch;
}

interface Administration {
  id: string | number;
  name?: string;
  currency?: string;
  country?: string;
}

/** Reports what the server would do with the current configuration, without starting it. */
export async function status(options: StatusOptions): Promise<boolean> {
  const store = options.store ?? new FileCredentialStore();
  const { config } = options;
  const access = permissionsFor(config);

  out.line('Configuration');
  out.line(`  toolsets          ${config.toolsets.join(', ')}`);
  out.line(`  write access      ${access.write ? 'enabled' : 'disabled'}`);
  out.line(`  delete access     ${access.destroy ? 'enabled' : 'disabled'}`);
  out.line(`  transport         ${config.transport}`);
  if (config.transport === 'http') out.line(`  listen            ${config.host}:${config.port}`);
  out.line(`  credentials file  ${store.location}`);
  if (config.timeZone) out.line(`  time zone         ${config.timeZone}`);

  const enabled = new Set(config.toolsets);
  const available = allTools.filter((tool) => enabled.has(tool.toolset));
  const exposed = available.filter(
    (tool) =>
      tool.access === 'read' ||
      (tool.access === 'write' && access.write) ||
      (tool.access === 'destroy' && access.destroy),
  );
  out.line(`  tools exposed     ${exposed.length} of ${available.length} in enabled toolsets`);

  out.step('Credentials');
  let auth;
  try {
    auth = await resolveAuth({
      config,
      store,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  } catch (error) {
    out.error(error instanceof Error ? error.message : String(error));
    return false;
  }

  const stored = await store.read();
  out.line(
    `  source            ${auth.source === 'environment' ? 'MONEYBIRD_API_TOKEN' : store.location}`,
  );
  if (stored) {
    out.line(`  kind              ${stored.kind}`);
    if (stored.scopes?.length) out.line(`  scopes            ${stored.scopes.join(', ')}`);
    if (stored.expiresAt) {
      out.line(`  expires           ${new Date(stored.expiresAt * 1000).toISOString()}`);
    }
  }

  out.step('Connection');
  const client = new MoneybirdClient({
    token: auth.getToken,
    ...(auth.administrationId ? { administrationId: auth.administrationId } : {}),
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    maxRetries: 0,
  });

  try {
    const response = await client.get<Administration[]>('administrations', {
      administrationScoped: false,
    });
    const administrations = Array.isArray(response.data) ? response.data : [];
    out.ok(`Reached Moneybird — ${administrations.length} administration(s) accessible`);
    for (const administration of administrations) {
      const marker = String(administration.id) === auth.administrationId ? '→' : ' ';
      out.line(`  ${marker} ${administration.id}  ${administration.name ?? ''}`);
    }
    if (!auth.administrationId) {
      out.warn('No default administration set — tools will need an explicit administration_id.');
    }
    return true;
  } catch (error) {
    if (error instanceof MoneybirdError) {
      out.error(`Moneybird returned ${error.status}: ${error.message}`);
    } else {
      out.error(error instanceof Error ? error.message : String(error));
    }
    return false;
  }
}

/** Prints the tools that the current configuration would expose. */
export function listTools(config: ServerConfig, asJson: boolean): void {
  const access = permissionsFor(config);
  const enabled = new Set(config.toolsets);

  const rows = allTools
    .filter((tool) => enabled.has(tool.toolset))
    .map((tool) => ({
      name: tool.name,
      toolset: tool.toolset,
      access: tool.access,
      exposed:
        tool.access === 'read' ||
        (tool.access === 'write' && access.write) ||
        (tool.access === 'destroy' && access.destroy),
      description: tool.description,
    }));

  if (asJson) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }

  let current = '';
  for (const row of rows) {
    if (row.toolset !== current) {
      current = row.toolset;
      out.line(`\n${current}`);
    }
    const marker = row.exposed ? ' ' : '·';
    out.line(`  ${marker} ${row.name.padEnd(38)} ${row.access}`);
  }
  out.line('\n· = hidden by the current write/delete settings');
}
