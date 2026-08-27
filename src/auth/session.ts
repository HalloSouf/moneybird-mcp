import type { ServerConfig } from '../config/schema.js';
import type { CredentialStore, StoredCredentials } from '../config/store.js';
import { MoneybirdClient, type TokenProvider } from '../moneybird/client.js';
import { MissingCredentialsError, resolveAuth } from './provider.js';

export interface Administration {
  id: string | number;
  name?: string;
  currency?: string;
  country?: string;
}

export interface AuthSessionOptions {
  config: ServerConfig;
  store: CredentialStore;
  fetch?: typeof globalThis.fetch;
}

/**
 * The server's live credential state.
 *
 * Startup must not fail when no credential exists yet — an unauthenticated server still serves the
 * connect tool, which is how a user gets one. The token provider therefore fails lazily, and
 * {@link AuthSession.connect} swaps in a working credential without a restart.
 */
export class AuthSession {
  private getStoredToken: TokenProvider | undefined;
  private administration: string | undefined;
  private authenticated = false;

  private constructor(
    private readonly options: AuthSessionOptions,
    resolved: { getToken: TokenProvider; administrationId: string | undefined } | undefined,
  ) {
    if (resolved) {
      this.getStoredToken = resolved.getToken;
      this.administration = resolved.administrationId;
      this.authenticated = true;
    } else {
      this.administration = options.config.administrationId;
    }
  }

  static async create(options: AuthSessionOptions): Promise<AuthSession> {
    try {
      const resolved = await resolveAuth({
        config: options.config,
        store: options.store,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      return new AuthSession(options, resolved);
    } catch (error) {
      if (error instanceof MissingCredentialsError) return new AuthSession(options, undefined);
      throw error;
    }
  }

  get isAuthenticated(): boolean {
    return this.authenticated;
  }

  get administrationId(): string | undefined {
    return this.administration;
  }

  get storeLocation(): string {
    return this.options.store.location;
  }

  readonly getToken: TokenProvider = async () => {
    if (!this.getStoredToken) {
      throw new MissingCredentialsError(
        'Not connected to Moneybird yet. Run the connect_moneybird tool, or `moneybird-mcp login`.',
      );
    }
    return this.getStoredToken();
  };

  /** Verifies a token by listing administrations, which is the one call every scope permits. */
  async verify(token: string): Promise<Administration[]> {
    const client = new MoneybirdClient({
      token,
      ...(this.options.config.baseUrl ? { baseUrl: this.options.config.baseUrl } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      maxRetries: 0,
    });

    const response = await client.get<Administration[]>('administrations', {
      administrationScoped: false,
    });
    return Array.isArray(response.data) ? response.data : [];
  }

  /** Stores a verified token and makes every already-registered tool start working. */
  async connect(token: string, administrationId?: string): Promise<StoredCredentials> {
    const credentials: StoredCredentials = {
      version: 1,
      kind: 'personal_access_token',
      accessToken: token,
      createdAt: new Date().toISOString(),
      ...(administrationId ? { administrationId } : {}),
    };

    await this.options.store.write(credentials);

    this.getStoredToken = () => token;
    this.authenticated = true;
    if (administrationId) this.administration = administrationId;

    return credentials;
  }

  /** Points subsequent requests at a different administration without re-authenticating. */
  selectAdministration(administrationId: string): void {
    this.administration = administrationId;
  }
}
