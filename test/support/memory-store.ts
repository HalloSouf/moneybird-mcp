import type {
  AuthorizationCode,
  AuthorizationRequest,
  AuthorizationStore,
  ConsumedCode,
  IssuedToken,
  MoneybirdCredential,
  OAuthClient,
} from '../../src/db/types.js';

/**
 * The authorization store in memory.
 *
 * Mirrors the Postgres implementation closely enough to drive the whole flow in a test, which is
 * the point: the interface exists so the flow can be exercised without a database.
 */
export class MemoryAuthorizationStore implements AuthorizationStore {
  readonly clients = new Map<string, OAuthClient>();
  readonly credentials = new Map<string, MoneybirdCredential>();
  readonly requests = new Map<string, AuthorizationRequest>();
  readonly codes = new Map<string, { code: AuthorizationCode; usedAt: Date | undefined }>();
  readonly tokens = new Map<string, IssuedToken>();

  async createClient(client: OAuthClient): Promise<void> {
    this.clients.set(client.clientId, client);
  }

  async findClient(clientId: string): Promise<OAuthClient | undefined> {
    return this.clients.get(clientId);
  }

  async createCredential(credential: MoneybirdCredential): Promise<void> {
    this.credentials.set(credential.id, { ...credential });
  }

  async findCredential(id: string): Promise<MoneybirdCredential | undefined> {
    const found = this.credentials.get(id);
    return found ? { ...found } : undefined;
  }

  async setCredentialAdministration(id: string, administrationId: string): Promise<void> {
    const found = this.credentials.get(id);
    if (found) this.credentials.set(id, { ...found, administrationId });
  }

  async updateCredentialTokens(
    id: string,
    tokens: { accessToken: string; refreshToken: string | undefined; expiresAt: Date | undefined },
  ): Promise<void> {
    const found = this.credentials.get(id);
    if (!found) return;
    this.credentials.set(id, {
      ...found,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? found.refreshToken,
      expiresAt: tokens.expiresAt,
    });
  }

  async revokeCredential(id: string): Promise<void> {
    const found = this.credentials.get(id);
    if (found) this.credentials.set(id, { ...found, revokedAt: new Date() });
  }

  async createAuthorizationRequest(request: AuthorizationRequest): Promise<void> {
    this.requests.set(request.id, { ...request });
  }

  async findAuthorizationRequest(id: string): Promise<AuthorizationRequest | undefined> {
    const found = this.requests.get(id);
    return found ? { ...found } : undefined;
  }

  async attachCredential(requestId: string, credentialId: string): Promise<void> {
    const found = this.requests.get(requestId);
    if (found) this.requests.set(requestId, { ...found, credentialId });
  }

  async deleteAuthorizationRequest(id: string): Promise<void> {
    this.requests.delete(id);
  }

  async createAuthorizationCode(code: AuthorizationCode): Promise<void> {
    this.codes.set(code.codeHash, { code: { ...code }, usedAt: undefined });
  }

  async consumeAuthorizationCode(codeHash: string): Promise<ConsumedCode | undefined> {
    const entry = this.codes.get(codeHash);
    if (!entry) return undefined;
    if (entry.usedAt) return { code: entry.code, alreadyUsed: true };
    entry.usedAt = new Date();
    return { code: entry.code, alreadyUsed: false };
  }

  async createToken(token: IssuedToken): Promise<void> {
    this.tokens.set(token.id, { ...token });
  }

  async findTokenByAccessHash(hash: string): Promise<IssuedToken | undefined> {
    for (const token of this.tokens.values()) {
      if (token.accessTokenHash === hash) return { ...token };
    }
    return undefined;
  }

  async findTokenByRefreshHash(hash: string): Promise<IssuedToken | undefined> {
    for (const token of this.tokens.values()) {
      if (token.refreshTokenHash === hash) return { ...token };
    }
    return undefined;
  }

  async revokeToken(id: string): Promise<void> {
    const found = this.tokens.get(id);
    if (found) this.tokens.set(id, { ...found, revokedAt: new Date() });
  }

  async revokeTokensForCredential(credentialId: string): Promise<void> {
    for (const [id, token] of this.tokens) {
      if (token.credentialId === credentialId && !token.revokedAt) {
        this.tokens.set(id, { ...token, revokedAt: new Date() });
      }
    }
  }

  async deleteExpired(now: Date): Promise<void> {
    for (const [id, request] of this.requests) {
      if (request.expiresAt < now) this.requests.delete(id);
    }
    for (const [hash, entry] of this.codes) {
      if (entry.code.expiresAt < now) this.codes.delete(hash);
    }
  }
}
