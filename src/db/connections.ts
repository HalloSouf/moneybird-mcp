import pg from 'pg';
import { SecretBox } from '../auth/server/crypto.js';

const { Pool } = pg;

export interface ConnectTicket {
  userId: string;
  email: string | undefined;
  expiresAt: Date;
  usedAt: Date | undefined;
}

export interface ConnectionTokens {
  accessToken: string;
  refreshToken: string | undefined;
  expiresAt: Date | undefined;
}

export interface Connection extends ConnectionTokens {
  id: string;
  userId: string;
}

export interface ConnectedAdministration {
  administrationId: string;
  name: string;
  connectionId: string;
}

export interface NewConnection extends ConnectionTokens {
  id: string;
  userId: string;
  scopes: readonly string[];
  administrations: ReadonlyArray<{ id: string; name: string }>;
}

export interface ConnectionStore {
  createTicket(
    ticketHash: string,
    userId: string,
    email: string | undefined,
    expiresAt: Date,
  ): Promise<void>;
  findTicket(ticketHash: string): Promise<ConnectTicket | undefined>;
  /** Marks an unused, unexpired ticket as used; undefined when it was neither. */
  consumeTicket(ticketHash: string, now: Date): Promise<ConnectTicket | undefined>;
  saveConnection(connection: NewConnection): Promise<void>;
  listAdministrations(userId: string): Promise<ConnectedAdministration[]>;
  findConnection(id: string): Promise<Connection | undefined>;
  updateTokens(id: string, tokens: ConnectionTokens): Promise<void>;
  /** Returns whether the administration was connected. */
  disconnect(userId: string, administrationId: string): Promise<boolean>;
  deleteExpiredTickets(now: Date): Promise<void>;
}

interface TicketRow {
  user_id: string;
  email: string | null;
  expires_at: Date;
  used_at: Date | null;
}

interface ConnectionRow {
  id: string;
  user_id: string;
  access_token: Buffer;
  refresh_token: Buffer | null;
  expires_at: Date | null;
}

function toTicket(row: TicketRow): ConnectTicket {
  return {
    userId: row.user_id,
    email: row.email ?? undefined,
    expiresAt: row.expires_at,
    usedAt: row.used_at ?? undefined,
  };
}

export interface PostgresConnectionStoreOptions {
  connectionString: string;
  encryptionKey: string;
  maxConnections?: number;
}

export class PostgresConnectionStore implements ConnectionStore {
  private readonly pool: pg.Pool;
  private readonly box: SecretBox;

  constructor(options: PostgresConnectionStoreOptions) {
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

  async createTicket(
    ticketHash: string,
    userId: string,
    email: string | undefined,
    expiresAt: Date,
  ): Promise<void> {
    await this.pool.query(
      'INSERT INTO connect_tickets (ticket_hash, user_id, email, expires_at) VALUES ($1, $2, $3, $4)',
      [ticketHash, userId, email ?? null, expiresAt],
    );
  }

  async findTicket(ticketHash: string): Promise<ConnectTicket | undefined> {
    const result = await this.pool.query<TicketRow>(
      'SELECT user_id, email, expires_at, used_at FROM connect_tickets WHERE ticket_hash = $1',
      [ticketHash],
    );
    const row = result.rows[0];
    return row ? toTicket(row) : undefined;
  }

  async consumeTicket(ticketHash: string, now: Date): Promise<ConnectTicket | undefined> {
    const result = await this.pool.query<TicketRow>(
      `UPDATE connect_tickets
          SET used_at = $2
        WHERE ticket_hash = $1 AND used_at IS NULL AND expires_at > $2
        RETURNING user_id, email, expires_at, used_at`,
      [ticketHash, now],
    );
    const row = result.rows[0];
    return row ? toTicket(row) : undefined;
  }

  async saveConnection(connection: NewConnection): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO moneybird_connections
           (id, user_id, access_token, refresh_token, expires_at, scopes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          connection.id,
          connection.userId,
          this.box.seal(connection.accessToken),
          connection.refreshToken ? this.box.seal(connection.refreshToken) : null,
          connection.expiresAt ?? null,
          [...connection.scopes],
        ],
      );
      for (const administration of connection.administrations) {
        await client.query(
          `INSERT INTO connected_administrations (user_id, administration_id, name, connection_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, administration_id) DO UPDATE
             SET name = EXCLUDED.name, connection_id = EXCLUDED.connection_id`,
          [connection.userId, administration.id, administration.name, connection.id],
        );
      }
      await this.deleteOrphans(client, connection.userId);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listAdministrations(userId: string): Promise<ConnectedAdministration[]> {
    const result = await this.pool.query<{
      administration_id: string;
      name: string;
      connection_id: string;
    }>(
      `SELECT administration_id, name, connection_id
         FROM connected_administrations
        WHERE user_id = $1
        ORDER BY name, administration_id`,
      [userId],
    );
    return result.rows.map((row) => ({
      administrationId: row.administration_id,
      name: row.name,
      connectionId: row.connection_id,
    }));
  }

  async findConnection(id: string): Promise<Connection | undefined> {
    const result = await this.pool.query<ConnectionRow>(
      `SELECT id, user_id, access_token, refresh_token, expires_at
         FROM moneybird_connections
        WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      userId: row.user_id,
      accessToken: this.box.open(row.access_token),
      refreshToken: row.refresh_token ? this.box.open(row.refresh_token) : undefined,
      expiresAt: row.expires_at ?? undefined,
    };
  }

  async updateTokens(id: string, tokens: ConnectionTokens): Promise<void> {
    await this.pool.query(
      `UPDATE moneybird_connections
          SET access_token = $2,
              refresh_token = COALESCE($3, refresh_token),
              expires_at = $4,
              updated_at = now()
        WHERE id = $1`,
      [
        id,
        this.box.seal(tokens.accessToken),
        tokens.refreshToken ? this.box.seal(tokens.refreshToken) : null,
        tokens.expiresAt ?? null,
      ],
    );
  }

  async disconnect(userId: string, administrationId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const deleted = await client.query(
        'DELETE FROM connected_administrations WHERE user_id = $1 AND administration_id = $2',
        [userId, administrationId],
      );
      await this.deleteOrphans(client, userId);
      await client.query('COMMIT');
      return (deleted.rowCount ?? 0) > 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteExpiredTickets(now: Date): Promise<void> {
    await this.pool.query('DELETE FROM connect_tickets WHERE expires_at < $1', [now]);
  }

  private async deleteOrphans(client: pg.PoolClient, userId: string): Promise<void> {
    await client.query(
      `DELETE FROM moneybird_connections c
        WHERE c.user_id = $1
          AND NOT EXISTS (SELECT 1 FROM connected_administrations a WHERE a.connection_id = c.id)`,
      [userId],
    );
  }
}
