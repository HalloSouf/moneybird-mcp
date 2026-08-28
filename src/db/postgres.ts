import pg from 'pg';
import { SecretBox } from '../auth/server/crypto.js';
import type {
  AuthorizationCode,
  AuthorizationRequest,
  AuthorizationStore,
  ConsumedCode,
  IssuedToken,
  MoneybirdCredential,
  OAuthClient,
} from './types.js';

const { Pool } = pg;

export interface PostgresStoreOptions {
  connectionString: string;
  encryptionKey: string;
  /** Bounded because a container this small should never open more than a handful. */
  maxConnections?: number;
}

interface ClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  created_at: Date;
}

interface CredentialRow {
  id: string;
  access_token: Buffer;
  refresh_token: Buffer | null;
  expires_at: Date | null;
  administration_id: string | null;
  scopes: string[] | null;
  revoked_at: Date | null;
}

interface RequestRow {
  id: string;
  client_id: string;
  redirect_uri: string;
  client_state: string | null;
  scope: string | null;
  code_challenge: string;
  code_challenge_method: string;
  resource: string | null;
  credential_id: string | null;
  expires_at: Date;
}

interface CodeRow {
  code_hash: string;
  client_id: string;
  credential_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  resource: string | null;
  expires_at: Date;
  used_at: Date | null;
}

interface TokenRow {
  id: string;
  client_id: string;
  credential_id: string;
  access_token_hash: string;
  refresh_token_hash: string | null;
  expires_at: Date;
  revoked_at: Date | null;
}

function toClient(row: ClientRow): OAuthClient {
  return {
    clientId: row.client_id,
    clientName: row.client_name ?? undefined,
    redirectUris: row.redirect_uris,
    grantTypes: row.grant_types,
    responseTypes: row.response_types,
    tokenEndpointAuthMethod: row.token_endpoint_auth_method,
    createdAt: row.created_at,
  };
}

function toRequest(row: RequestRow): AuthorizationRequest {
  return {
    id: row.id,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    clientState: row.client_state ?? undefined,
    scope: row.scope ?? undefined,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
    resource: row.resource ?? undefined,
    credentialId: row.credential_id ?? undefined,
    expiresAt: row.expires_at,
  };
}

function toCode(row: CodeRow): AuthorizationCode {
  return {
    codeHash: row.code_hash,
    clientId: row.client_id,
    credentialId: row.credential_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
    resource: row.resource ?? undefined,
    expiresAt: row.expires_at,
  };
}

function toToken(row: TokenRow): IssuedToken {
  return {
    id: row.id,
    clientId: row.client_id,
    credentialId: row.credential_id,
    accessTokenHash: row.access_token_hash,
    refreshTokenHash: row.refresh_token_hash ?? undefined,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? undefined,
  };
}

/** The authorization server's state in Postgres, with Moneybird's tokens encrypted at rest. */
export class PostgresAuthorizationStore implements AuthorizationStore {
  private readonly pool: pg.Pool;
  private readonly box: SecretBox;

  constructor(options: PostgresStoreOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.maxConnections ?? 10,
    });
    this.box = new SecretBox(options.encryptionKey);
  }

  get connectionPool(): pg.Pool {
    return this.pool;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createClient(client: OAuthClient): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_clients
         (client_id, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        client.clientId,
        client.clientName ?? null,
        [...client.redirectUris],
        [...client.grantTypes],
        [...client.responseTypes],
        client.tokenEndpointAuthMethod,
      ],
    );
  }

  /**
   * Writes a client whose identity comes from a url rather than a registration.
   *
   * The document is the source of truth and can change between authorizations, so this refreshes
   * what it declares instead of failing on the second visit.
   */
  async upsertClient(client: OAuthClient): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_clients
         (client_id, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (client_id) DO UPDATE
         SET client_name = EXCLUDED.client_name,
             redirect_uris = EXCLUDED.redirect_uris,
             grant_types = EXCLUDED.grant_types,
             response_types = EXCLUDED.response_types,
             token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method`,
      [
        client.clientId,
        client.clientName ?? null,
        [...client.redirectUris],
        [...client.grantTypes],
        [...client.responseTypes],
        client.tokenEndpointAuthMethod,
      ],
    );
  }

  async findClient(clientId: string): Promise<OAuthClient | undefined> {
    const result = await this.pool.query<ClientRow>(
      'SELECT * FROM oauth_clients WHERE client_id = $1',
      [clientId],
    );
    const row = result.rows[0];
    return row ? toClient(row) : undefined;
  }

  async createCredential(credential: MoneybirdCredential): Promise<void> {
    await this.pool.query(
      `INSERT INTO moneybird_credentials
         (id, access_token, refresh_token, expires_at, administration_id, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        credential.id,
        this.box.seal(credential.accessToken),
        credential.refreshToken ? this.box.seal(credential.refreshToken) : null,
        credential.expiresAt ?? null,
        credential.administrationId ?? null,
        [...credential.scopes],
      ],
    );
  }

  async findCredential(id: string): Promise<MoneybirdCredential | undefined> {
    const result = await this.pool.query<CredentialRow>(
      'SELECT * FROM moneybird_credentials WHERE id = $1',
      [id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      accessToken: this.box.open(row.access_token),
      refreshToken: row.refresh_token ? this.box.open(row.refresh_token) : undefined,
      expiresAt: row.expires_at ?? undefined,
      administrationId: row.administration_id ?? undefined,
      scopes: row.scopes ?? [],
      revokedAt: row.revoked_at ?? undefined,
    };
  }

  async setCredentialAdministration(id: string, administrationId: string): Promise<void> {
    await this.pool.query('UPDATE moneybird_credentials SET administration_id = $2 WHERE id = $1', [
      id,
      administrationId,
    ]);
  }

  async updateCredentialTokens(
    id: string,
    tokens: { accessToken: string; refreshToken: string | undefined; expiresAt: Date | undefined },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE moneybird_credentials
          SET access_token = $2,
              refresh_token = COALESCE($3, refresh_token),
              expires_at = $4
        WHERE id = $1`,
      [
        id,
        this.box.seal(tokens.accessToken),
        tokens.refreshToken ? this.box.seal(tokens.refreshToken) : null,
        tokens.expiresAt ?? null,
      ],
    );
  }

  async revokeCredential(id: string): Promise<void> {
    await this.pool.query(
      'UPDATE moneybird_credentials SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
      [id],
    );
  }

  async createAuthorizationRequest(request: AuthorizationRequest): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_authorization_requests
         (id, client_id, redirect_uri, client_state, scope, code_challenge, code_challenge_method,
          resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        request.id,
        request.clientId,
        request.redirectUri,
        request.clientState ?? null,
        request.scope ?? null,
        request.codeChallenge,
        request.codeChallengeMethod,
        request.resource ?? null,
        request.expiresAt,
      ],
    );
  }

  async findAuthorizationRequest(id: string): Promise<AuthorizationRequest | undefined> {
    const result = await this.pool.query<RequestRow>(
      'SELECT * FROM oauth_authorization_requests WHERE id = $1',
      [id],
    );
    const row = result.rows[0];
    return row ? toRequest(row) : undefined;
  }

  async attachCredential(requestId: string, credentialId: string): Promise<void> {
    await this.pool.query(
      'UPDATE oauth_authorization_requests SET credential_id = $2 WHERE id = $1',
      [requestId, credentialId],
    );
  }

  async deleteAuthorizationRequest(id: string): Promise<void> {
    await this.pool.query('DELETE FROM oauth_authorization_requests WHERE id = $1', [id]);
  }

  async createAuthorizationCode(code: AuthorizationCode): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_authorization_codes
         (code_hash, client_id, credential_id, redirect_uri, code_challenge, code_challenge_method,
          resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        code.codeHash,
        code.clientId,
        code.credentialId,
        code.redirectUri,
        code.codeChallenge,
        code.codeChallengeMethod,
        code.resource ?? null,
        code.expiresAt,
      ],
    );
  }

  /**
   * Spends a code in one statement.
   *
   * The UPDATE only matches an unused row, so two simultaneous exchanges cannot both win; the
   * loser still gets the row back through the second query and the caller treats it as replay.
   */
  async consumeAuthorizationCode(codeHash: string): Promise<ConsumedCode | undefined> {
    const claimed = await this.pool.query<CodeRow>(
      `UPDATE oauth_authorization_codes
          SET used_at = now()
        WHERE code_hash = $1 AND used_at IS NULL
        RETURNING *`,
      [codeHash],
    );
    const claimedRow = claimed.rows[0];
    if (claimedRow) return { code: toCode(claimedRow), alreadyUsed: false };

    const existing = await this.pool.query<CodeRow>(
      'SELECT * FROM oauth_authorization_codes WHERE code_hash = $1',
      [codeHash],
    );
    const row = existing.rows[0];
    return row ? { code: toCode(row), alreadyUsed: true } : undefined;
  }

  async createToken(token: IssuedToken): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_tokens
         (id, client_id, credential_id, access_token_hash, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        token.id,
        token.clientId,
        token.credentialId,
        token.accessTokenHash,
        token.refreshTokenHash ?? null,
        token.expiresAt,
      ],
    );
  }

  async findTokenByAccessHash(hash: string): Promise<IssuedToken | undefined> {
    const result = await this.pool.query<TokenRow>(
      'SELECT * FROM oauth_tokens WHERE access_token_hash = $1',
      [hash],
    );
    const row = result.rows[0];
    return row ? toToken(row) : undefined;
  }

  async findTokenByRefreshHash(hash: string): Promise<IssuedToken | undefined> {
    const result = await this.pool.query<TokenRow>(
      'SELECT * FROM oauth_tokens WHERE refresh_token_hash = $1',
      [hash],
    );
    const row = result.rows[0];
    return row ? toToken(row) : undefined;
  }

  async revokeToken(id: string): Promise<void> {
    await this.pool.query(
      'UPDATE oauth_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
      [id],
    );
  }

  async revokeTokensForCredential(credentialId: string): Promise<void> {
    await this.pool.query(
      'UPDATE oauth_tokens SET revoked_at = now() WHERE credential_id = $1 AND revoked_at IS NULL',
      [credentialId],
    );
  }

  async deleteExpired(now: Date): Promise<void> {
    await this.pool.query('DELETE FROM oauth_authorization_requests WHERE expires_at < $1', [now]);
    await this.pool.query('DELETE FROM oauth_authorization_codes WHERE expires_at < $1', [now]);
    await this.pool.query(
      'DELETE FROM oauth_tokens WHERE expires_at < $1 AND refresh_token_hash IS NULL',
      [now],
    );
  }
}
