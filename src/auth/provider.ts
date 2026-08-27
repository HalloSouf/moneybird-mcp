import type { CredentialStore, StoredCredentials } from '../config/store.js';
import type { ServerConfig } from '../config/schema.js';
import type { TokenProvider } from '../moneybird/client.js';
import { refreshAccessToken } from './oauth.js';

/** Raised when no usable credential exists, so callers can steer the user into authentication. */
export class MissingCredentialsError extends Error {
  constructor(message = 'No Moneybird credentials found.') {
    super(message);
    this.name = 'MissingCredentialsError';
  }
}

/** Refresh this many seconds before expiry so an in-flight request never races the deadline. */
const REFRESH_LEEWAY_SECONDS = 300;

export interface ResolvedAuth {
  getToken: TokenProvider;
  /** Administration recorded alongside the credential, used when config names none. */
  administrationId: string | undefined;
  source: 'environment' | 'stored';
}

function isExpiring(credentials: StoredCredentials, nowSeconds: number): boolean {
  if (credentials.expiresAt === undefined) return false;
  return credentials.expiresAt - REFRESH_LEEWAY_SECONDS <= nowSeconds;
}

export interface ResolveAuthOptions {
  config: ServerConfig;
  store: CredentialStore;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/**
 * Chooses the credential to authenticate with.
 *
 * An explicit `MONEYBIRD_API_TOKEN` always wins, so a container or CI run never picks up a
 * developer's stored login. Otherwise the stored credential is used, refreshing it first
 * when it is an OAuth token that is close to expiring.
 */
export async function resolveAuth(options: ResolveAuthOptions): Promise<ResolvedAuth> {
  const { config, store } = options;

  if (config.apiToken) {
    const token = config.apiToken;
    return {
      getToken: () => token,
      administrationId: config.administrationId,
      source: 'environment',
    };
  }

  const stored = await store.read();
  if (!stored) {
    throw new MissingCredentialsError(
      'No Moneybird credentials found. Run `moneybird-mcp login`, or set MONEYBIRD_API_TOKEN.',
    );
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;

  let current = stored;
  let refreshing: Promise<string> | undefined;

  const getToken: TokenProvider = async () => {
    if (!isExpiring(current, Math.floor(now() / 1000))) return current.accessToken;

    // Concurrent tool calls must not each burn the single-use refresh token.
    refreshing ??= (async () => {
      try {
        if (!current.refreshToken || !current.clientId || !current.clientSecret) {
          throw new MissingCredentialsError(
            'The stored token has expired and cannot be refreshed. Run `moneybird-mcp login` again.',
          );
        }
        const refreshed = await refreshAccessToken({
          clientId: current.clientId,
          clientSecret: current.clientSecret,
          refreshToken: current.refreshToken,
          fetch: fetchImpl,
          now,
        });
        current = {
          ...current,
          accessToken: refreshed.accessToken,
          ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
          ...(refreshed.expiresAt !== undefined ? { expiresAt: refreshed.expiresAt } : {}),
        };
        await store.write(current);
        return current.accessToken;
      } finally {
        refreshing = undefined;
      }
    })();

    return refreshing;
  };

  return {
    getToken,
    administrationId: config.administrationId ?? stored.administrationId,
    source: 'stored',
  };
}
