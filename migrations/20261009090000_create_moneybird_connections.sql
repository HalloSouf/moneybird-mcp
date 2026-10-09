-- Storage for the `airlock` HTTP mode: Airlock authenticates the user, this server keeps each
-- user's Moneybird authorizations. Tokens are encrypted with MONEYBIRD_TOKEN_ENCRYPTION_KEY.

-- One row per Moneybird authorization. Refreshing rotates the tokens in place.
CREATE TABLE IF NOT EXISTS moneybird_connections (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  access_token bytea NOT NULL,
  refresh_token bytea,
  expires_at timestamptz,
  scopes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS moneybird_connections_user_id_idx ON moneybird_connections (user_id);

-- Which connection serves which administration for a user. Authorizing an administration again
-- repoints its row at the new connection.
CREATE TABLE IF NOT EXISTS connected_administrations (
  user_id text NOT NULL,
  administration_id text NOT NULL,
  name text NOT NULL,
  connection_id text NOT NULL REFERENCES moneybird_connections (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, administration_id)
);

CREATE INDEX IF NOT EXISTS connected_administrations_connection_id_idx
  ON connected_administrations (connection_id);

-- Single-use links that tie a browser authorization to the Airlock user who asked for it. The
-- browser leg reaches this server without an identity, so the ticket is the only binding.
CREATE TABLE IF NOT EXISTS connect_tickets (
  ticket_hash text PRIMARY KEY,
  user_id text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE INDEX IF NOT EXISTS connect_tickets_expires_at_idx ON connect_tickets (expires_at);
