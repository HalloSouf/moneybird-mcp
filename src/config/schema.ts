import { z } from 'zod';

/** Tool groups that can be enabled independently, mirroring the Moneybird API's own domains. */
export const TOOLSETS = [
  'core',
  'invoicing',
  'purchases',
  'banking',
  'time',
  'reports',
  'assets',
  'tasks',
  'webhooks',
] as const;

export const Toolset = z.enum(TOOLSETS);
export type Toolset = z.infer<typeof Toolset>;

/** Enabled unless `MONEYBIRD_TOOLSETS` says otherwise; the rest are opt-in. */
export const DEFAULT_TOOLSETS: readonly Toolset[] = [
  'core',
  'invoicing',
  'purchases',
  'banking',
  'time',
];

export const OAUTH_SCOPES = [
  'sales_invoices',
  'documents',
  'estimates',
  'bank',
  'time_entries',
  'settings',
] as const;

export const OAuthScope = z.enum(OAUTH_SCOPES);
export type OAuthScope = z.infer<typeof OAuthScope>;

export const Transport = z.enum(['stdio', 'http']);
export type Transport = z.infer<typeof Transport>;

export const ServerConfig = z.object({
  apiToken: z.string().min(1).optional(),
  administrationId: z.string().optional(),
  baseUrl: z.string().url().optional(),
  timeZone: z.string().optional(),
  toolsets: z.array(Toolset).nonempty(),
  allowWrite: z.boolean(),
  allowDelete: z.boolean(),
  transport: Transport,
  host: z.string(),
  port: z.number().int().min(0).max(65_535),
  oauth: z
    .object({
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
      scopes: z.array(OAuthScope).nonempty(),
      redirectUri: z.string().url().optional(),
    })
    .optional(),
  /** Public origin the OAuth flow advertises itself on, e.g. `https://mcp.example.com`. */
  publicUrl: z.string().url().optional(),
  /** Postgres holding the authorization server's state. Required by the `oauth` HTTP mode. */
  databaseUrl: z.string().min(1).optional(),
  /** 32 bytes of hex encrypting Moneybird tokens at rest. Required by the `oauth` HTTP mode. */
  tokenEncryptionKey: z.string().min(1).optional(),
  requestTimeoutMs: z.number().int().positive(),
  maxRetries: z.number().int().min(0),
});
export type ServerConfig = z.infer<typeof ServerConfig>;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Accepts `all`, `none`, or a comma-separated list; `-name` removes one from the defaults. */
export function resolveToolsets(raw: string | undefined): Toolset[] {
  const entries = parseList(raw);
  if (entries.length === 0) return [...DEFAULT_TOOLSETS];

  const normalised = entries.map((entry) => entry.toLowerCase());
  if (normalised.includes('all')) return [...TOOLSETS];

  const selected = new Set<Toolset>(
    normalised.some((entry) => entry.startsWith('-')) ? DEFAULT_TOOLSETS : [],
  );

  for (const entry of normalised) {
    if (entry === 'none') {
      selected.clear();
      continue;
    }
    const removing = entry.startsWith('-');
    const name = removing ? entry.slice(1) : entry;
    const parsed = Toolset.safeParse(name);
    if (!parsed.success) {
      throw new ConfigError(
        `Unknown toolset "${name}". Valid toolsets: ${TOOLSETS.join(', ')} (or "all").`,
      );
    }
    if (removing) selected.delete(parsed.data);
    else selected.add(parsed.data);
  }

  if (selected.size === 0) {
    throw new ConfigError('No toolsets enabled. Set MONEYBIRD_TOOLSETS to at least one toolset.');
  }
  return TOOLSETS.filter((toolset) => selected.has(toolset));
}

function resolveScopes(raw: string | undefined): OAuthScope[] {
  const entries = parseList(raw);
  if (entries.length === 0) return [...OAUTH_SCOPES];

  return entries.map((entry) => {
    const parsed = OAuthScope.safeParse(entry.toLowerCase());
    if (!parsed.success) {
      throw new ConfigError(
        `Unknown OAuth scope "${entry}". Valid scopes: ${OAUTH_SCOPES.join(', ')}.`,
      );
    }
    return parsed.data;
  });
}

/** Reads configuration from the environment; CLI flags are layered on top by the caller. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const clientId = env['MONEYBIRD_CLIENT_ID'];
  const clientSecret = env['MONEYBIRD_CLIENT_SECRET'];

  if ((clientId && !clientSecret) || (!clientId && clientSecret)) {
    throw new ConfigError(
      'OAuth needs both MONEYBIRD_CLIENT_ID and MONEYBIRD_CLIENT_SECRET; only one was set.',
    );
  }

  const transport = Transport.safeParse((env['MONEYBIRD_TRANSPORT'] ?? 'stdio').toLowerCase());
  if (!transport.success) {
    throw new ConfigError('MONEYBIRD_TRANSPORT must be "stdio" or "http".');
  }

  const config: ServerConfig = {
    ...(env['MONEYBIRD_API_TOKEN'] ? { apiToken: env['MONEYBIRD_API_TOKEN'] } : {}),
    ...(env['MONEYBIRD_ADMINISTRATION_ID']
      ? { administrationId: env['MONEYBIRD_ADMINISTRATION_ID'] }
      : {}),
    ...(env['MONEYBIRD_BASE_URL'] ? { baseUrl: env['MONEYBIRD_BASE_URL'] } : {}),
    ...(env['MONEYBIRD_TIME_ZONE'] ? { timeZone: env['MONEYBIRD_TIME_ZONE'] } : {}),
    toolsets: resolveToolsets(env['MONEYBIRD_TOOLSETS']) as [Toolset, ...Toolset[]],
    allowWrite: parseBoolean(env['MONEYBIRD_ALLOW_WRITE'], false),
    allowDelete: parseBoolean(env['MONEYBIRD_ALLOW_DELETE'], false),
    transport: transport.data,
    host: env['MONEYBIRD_HOST'] ?? '127.0.0.1',
    port: parseInteger(env['PORT'] ?? env['MONEYBIRD_PORT'], 3000),
    ...(clientId && clientSecret
      ? {
          oauth: {
            clientId,
            clientSecret,
            scopes: resolveScopes(env['MONEYBIRD_OAUTH_SCOPES']) as [OAuthScope, ...OAuthScope[]],
            ...(env['MONEYBIRD_REDIRECT_URI']
              ? { redirectUri: env['MONEYBIRD_REDIRECT_URI'] }
              : {}),
          },
        }
      : {}),
    ...(env['MONEYBIRD_PUBLIC_URL']
      ? { publicUrl: env['MONEYBIRD_PUBLIC_URL'].replace(/\/+$/, '') }
      : {}),
    ...(env['MONEYBIRD_DATABASE_URL'] ? { databaseUrl: env['MONEYBIRD_DATABASE_URL'] } : {}),
    ...(env['MONEYBIRD_TOKEN_ENCRYPTION_KEY']
      ? { tokenEncryptionKey: env['MONEYBIRD_TOKEN_ENCRYPTION_KEY'] }
      : {}),
    requestTimeoutMs: parseInteger(env['MONEYBIRD_REQUEST_TIMEOUT_MS'], 30_000),
    maxRetries: parseInteger(env['MONEYBIRD_MAX_RETRIES'], 3),
  };

  return ServerConfig.parse(config);
}

/** Deleting is gated behind its own flag, so `allowWrite` alone never permits destruction. */
export function permissionsFor(config: ServerConfig): { write: boolean; destroy: boolean } {
  return { write: config.allowWrite, destroy: config.allowWrite && config.allowDelete };
}
