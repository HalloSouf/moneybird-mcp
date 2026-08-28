-- Storage for the OAuth authorization server the HTTP transport exposes in `oauth` mode.
--
-- Two kinds of secret live here and they are protected differently. Tokens this server issues are
-- stored as SHA-256 hashes: a request presents one, so a hash is enough to recognise it and a leak
-- of this table reveals nothing usable. Moneybird's tokens have to be replayed against Moneybird,
-- so they are encrypted with AES-256-GCM under MONEYBIRD_TOKEN_ENCRYPTION_KEY and a database dump
-- on its own is not enough to reach anybody's administration.

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id text PRIMARY KEY,
  client_name text,
  redirect_uris text[] NOT NULL,
  grant_types text[] NOT NULL DEFAULT ARRAY['authorization_code', 'refresh_token'],
  response_types text[] NOT NULL DEFAULT ARRAY['code'],
  token_endpoint_auth_method text NOT NULL DEFAULT 'none',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per Moneybird authorization. Survives token rotation: refreshing our own access token
-- mints a new oauth_tokens row against the same credential.
CREATE TABLE IF NOT EXISTS moneybird_credentials (
  id text PRIMARY KEY,
  access_token bytea NOT NULL,
  refresh_token bytea,
  expires_at timestamptz,
  administration_id text,
  scopes text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

-- The leg between /authorize and the Moneybird callback. Short-lived by design.
CREATE TABLE IF NOT EXISTS oauth_authorization_requests (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  client_state text,
  scope text,
  code_challenge text NOT NULL,
  code_challenge_method text NOT NULL,
  resource text,
  credential_id text REFERENCES moneybird_credentials (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_authorization_requests_expires_at_idx
  ON oauth_authorization_requests (expires_at);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  credential_id text NOT NULL REFERENCES moneybird_credentials (id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  code_challenge_method text NOT NULL,
  resource text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE INDEX IF NOT EXISTS oauth_authorization_codes_expires_at_idx
  ON oauth_authorization_codes (expires_at);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  credential_id text NOT NULL REFERENCES moneybird_credentials (id) ON DELETE CASCADE,
  access_token_hash text NOT NULL UNIQUE,
  refresh_token_hash text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS oauth_tokens_credential_id_idx ON oauth_tokens (credential_id);
