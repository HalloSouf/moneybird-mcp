/** An OAuth client that registered itself through Dynamic Client Registration. */
export interface OAuthClient {
  clientId: string;
  clientName: string | undefined;
  redirectUris: readonly string[];
  grantTypes: readonly string[];
  responseTypes: readonly string[];
  tokenEndpointAuthMethod: string;
  createdAt?: Date;
}

/** The authorization in flight between `/authorize` and Moneybird's callback. */
export interface AuthorizationRequest {
  id: string;
  clientId: string;
  redirectUri: string;
  clientState: string | undefined;
  scope: string | undefined;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string | undefined;
  credentialId: string | undefined;
  expiresAt: Date;
}

/**
 * A Moneybird authorization.
 *
 * Tokens cross this boundary in plaintext; the Postgres implementation seals them on the way in
 * and opens them on the way out, so no caller has to remember to encrypt.
 */
export interface MoneybirdCredential {
  id: string;
  accessToken: string;
  refreshToken: string | undefined;
  expiresAt: Date | undefined;
  administrationId: string | undefined;
  scopes: readonly string[];
  revokedAt?: Date | undefined;
}

export interface AuthorizationCode {
  codeHash: string;
  clientId: string;
  credentialId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string | undefined;
  expiresAt: Date;
}

export interface IssuedToken {
  id: string;
  clientId: string;
  credentialId: string;
  accessTokenHash: string;
  refreshTokenHash: string | undefined;
  expiresAt: Date;
  revokedAt: Date | undefined;
}

/** What a code lookup found, including a code that was already spent. */
export interface ConsumedCode {
  code: AuthorizationCode;
  alreadyUsed: boolean;
}

/**
 * Everything the authorization server persists.
 *
 * Kept as an interface so the flow can be tested end to end against an in-memory implementation
 * without a database, and so the encryption of Moneybird tokens stays an implementation detail.
 */
export interface AuthorizationStore {
  createClient(client: OAuthClient): Promise<void>;
  /** Inserts or refreshes a client, for identities that are resolved rather than registered. */
  upsertClient(client: OAuthClient): Promise<void>;
  findClient(clientId: string): Promise<OAuthClient | undefined>;

  createCredential(credential: MoneybirdCredential): Promise<void>;
  findCredential(id: string): Promise<MoneybirdCredential | undefined>;
  setCredentialAdministration(id: string, administrationId: string): Promise<void>;
  updateCredentialTokens(
    id: string,
    tokens: { accessToken: string; refreshToken: string | undefined; expiresAt: Date | undefined },
  ): Promise<void>;
  revokeCredential(id: string): Promise<void>;

  createAuthorizationRequest(request: AuthorizationRequest): Promise<void>;
  findAuthorizationRequest(id: string): Promise<AuthorizationRequest | undefined>;
  attachCredential(requestId: string, credentialId: string): Promise<void>;
  deleteAuthorizationRequest(id: string): Promise<void>;

  createAuthorizationCode(code: AuthorizationCode): Promise<void>;
  /** Marks the code spent and returns it, reporting whether it had already been used. */
  consumeAuthorizationCode(codeHash: string): Promise<ConsumedCode | undefined>;

  createToken(token: IssuedToken): Promise<void>;
  findTokenByAccessHash(hash: string): Promise<IssuedToken | undefined>;
  findTokenByRefreshHash(hash: string): Promise<IssuedToken | undefined>;
  revokeToken(id: string): Promise<void>;
  revokeTokensForCredential(credentialId: string): Promise<void>;

  /** Housekeeping: drops rows that can no longer be used. */
  deleteExpired(now: Date): Promise<void>;
}
