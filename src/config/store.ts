import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { credentialsPath } from './paths.js';

/** How the stored token was obtained, which determines whether it can be refreshed. */
export const CredentialKind = z.enum(['personal_access_token', 'oauth']);
export type CredentialKind = z.infer<typeof CredentialKind>;

export const StoredCredentials = z.object({
  version: z.literal(1).default(1),
  kind: CredentialKind,
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  /** Unix epoch seconds. Absent for tokens Moneybird does not currently expire. */
  expiresAt: z.number().int().positive().optional(),
  scopes: z.array(z.string()).optional(),
  administrationId: z.string().optional(),
  administrationName: z.string().optional(),
  /** Present for OAuth credentials so a refresh can re-authenticate the client. */
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  createdAt: z.string().optional(),
});
export type StoredCredentials = z.infer<typeof StoredCredentials>;

export interface CredentialStore {
  read(): Promise<StoredCredentials | undefined>;
  write(credentials: StoredCredentials): Promise<void>;
  clear(): Promise<void>;
  readonly location: string;
}

/**
 * Credentials on disk at `~/.config/moneybird-mcp/credentials.json`.
 *
 * The file holds a long-lived token with full access to an administration, so it is written
 * `0600` and its parent directory `0700`. On Windows these modes are a no-op and access
 * control comes from the user profile directory instead.
 */
export class FileCredentialStore implements CredentialStore {
  readonly location: string;

  constructor(location: string = credentialsPath()) {
    this.location = location;
  }

  async read(): Promise<StoredCredentials | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.location, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }

    // Invalid syntax and a valid-JSON-but-wrong-shape file are the same problem to the user,
    // so both must name the file rather than surfacing a bare SyntaxError.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `Credentials at ${this.location} are not valid JSON. Run \`moneybird-mcp logout\` and authenticate again.`,
      );
    }

    const result = StoredCredentials.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Credentials at ${this.location} are malformed. Run \`moneybird-mcp logout\` and authenticate again.`,
      );
    }
    return result.data;
  }

  async write(credentials: StoredCredentials): Promise<void> {
    await mkdir(dirname(this.location), { recursive: true, mode: 0o700 });
    await writeFile(this.location, `${JSON.stringify(credentials, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    // writeFile only applies `mode` when it creates the file, so an existing file keeps its old bits.
    await chmod(this.location, 0o600).catch(() => undefined);
  }

  async clear(): Promise<void> {
    await rm(this.location, { force: true });
  }
}

/** Non-persistent store used by tests and by deployments that pass tokens through the environment. */
export class MemoryCredentialStore implements CredentialStore {
  readonly location = '<memory>';
  private credentials: StoredCredentials | undefined;

  constructor(initial?: StoredCredentials) {
    this.credentials = initial;
  }

  async read(): Promise<StoredCredentials | undefined> {
    return this.credentials;
  }

  async write(credentials: StoredCredentials): Promise<void> {
    this.credentials = credentials;
  }

  async clear(): Promise<void> {
    this.credentials = undefined;
  }
}
