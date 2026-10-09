import type {
  ConnectedAdministration,
  Connection,
  ConnectionStore,
  ConnectionTokens,
  ConnectTicket,
  NewConnection,
} from '../../src/db/connections.js';

interface StoredTicket extends ConnectTicket {
  hash: string;
}

export class MemoryConnectionStore implements ConnectionStore {
  readonly tickets: StoredTicket[] = [];
  readonly connections = new Map<string, Connection>();
  readonly administrations: Array<ConnectedAdministration & { userId: string }> = [];

  async createTicket(
    ticketHash: string,
    userId: string,
    email: string | undefined,
    expiresAt: Date,
  ): Promise<void> {
    this.tickets.push({ hash: ticketHash, userId, email, expiresAt, usedAt: undefined });
  }

  async findTicket(ticketHash: string): Promise<ConnectTicket | undefined> {
    return this.tickets.find((ticket) => ticket.hash === ticketHash);
  }

  async consumeTicket(ticketHash: string, now: Date): Promise<ConnectTicket | undefined> {
    const ticket = this.tickets.find((entry) => entry.hash === ticketHash);
    if (!ticket || ticket.usedAt || ticket.expiresAt <= now) return undefined;
    ticket.usedAt = now;
    return ticket;
  }

  async saveConnection(connection: NewConnection): Promise<void> {
    this.connections.set(connection.id, {
      id: connection.id,
      userId: connection.userId,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      expiresAt: connection.expiresAt,
    });
    for (const administration of connection.administrations) {
      const existing = this.administrations.find(
        (entry) =>
          entry.userId === connection.userId && entry.administrationId === administration.id,
      );
      if (existing) {
        existing.name = administration.name;
        existing.connectionId = connection.id;
      } else {
        this.administrations.push({
          userId: connection.userId,
          administrationId: administration.id,
          name: administration.name,
          connectionId: connection.id,
        });
      }
    }
    this.deleteOrphans();
  }

  async listAdministrations(userId: string): Promise<ConnectedAdministration[]> {
    return this.administrations
      .filter((entry) => entry.userId === userId)
      .map(({ administrationId, name, connectionId }) => ({
        administrationId,
        name,
        connectionId,
      }));
  }

  async findConnection(id: string): Promise<Connection | undefined> {
    const connection = this.connections.get(id);
    return connection ? { ...connection } : undefined;
  }

  async updateTokens(id: string, tokens: ConnectionTokens): Promise<void> {
    const connection = this.connections.get(id);
    if (!connection) return;
    this.connections.set(id, {
      ...connection,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? connection.refreshToken,
      expiresAt: tokens.expiresAt,
    });
  }

  async disconnect(userId: string, administrationId: string): Promise<boolean> {
    const index = this.administrations.findIndex(
      (entry) => entry.userId === userId && entry.administrationId === administrationId,
    );
    if (index === -1) return false;
    this.administrations.splice(index, 1);
    this.deleteOrphans();
    return true;
  }

  async deleteExpiredTickets(now: Date): Promise<void> {
    for (let index = this.tickets.length - 1; index >= 0; index -= 1) {
      if ((this.tickets[index] as StoredTicket).expiresAt < now) this.tickets.splice(index, 1);
    }
  }

  private deleteOrphans(): void {
    for (const id of this.connections.keys()) {
      if (!this.administrations.some((entry) => entry.connectionId === id)) {
        this.connections.delete(id);
      }
    }
  }
}
