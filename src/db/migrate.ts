import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/** `dist/db/migrate.js` and `src/db/migrate.ts` are both two levels below the package root. */
function defaultMigrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
}

export interface MigrateOptions {
  pool: pg.Pool;
  directory?: string;
  onApplied?: (name: string) => void;
}

/**
 * Applies every migration the database has not seen yet.
 *
 * Runs before the server listens, so a deploy can never serve requests against a schema that is
 * one release behind. Each file runs inside its own transaction together with the bookkeeping
 * row, which makes a half-applied migration impossible; a failure aborts startup rather than
 * leaving the schema in a state nobody can name.
 *
 * A Postgres advisory lock serialises concurrent boots, so scaling to more than one replica does
 * not race two migrators against each other.
 */
export async function migrate(options: MigrateOptions): Promise<string[]> {
  const directory = options.directory ?? defaultMigrationsDir();
  const client = await options.pool.connect();
  const applied: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // An arbitrary but stable key: "moneybird-mcp migrations".
    await client.query('SELECT pg_advisory_lock($1)', [4_073_918_221]);

    try {
      const existing = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
      const done = new Set(existing.rows.map((row) => row.name));

      const files = (await readdir(directory))
        .filter((name) => name.endsWith('.sql'))
        .sort((a, b) => a.localeCompare(b));

      for (const name of files) {
        if (done.has(name)) continue;

        const sql = await readFile(join(directory, name), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw new Error(
            `Migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }

        applied.push(name);
        options.onApplied?.(name);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [4_073_918_221]);
    }
  } finally {
    client.release();
  }

  return applied;
}
