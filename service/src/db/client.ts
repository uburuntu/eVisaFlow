import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { schema } from "./schema.js";

/**
 * Stable database handle type used across the service. It is a Drizzle
 * `node-postgres` database bound to the full {@link schema}; every `db/*` query
 * module accepts this as its first argument. The seam (and all `db/*`
 * signatures) is unchanged from the previous Supabase implementation — only the
 * underlying driver moved to portable Postgres (Drizzle + `pg`).
 */
export type Db = NodePgDatabase<typeof schema>;

/**
 * Builds a portable Postgres handle from a connection string.
 *
 * SAFETY: `databaseUrl` must point at a local/self-hosted Postgres. Never aim a
 * service instance (or migrations) at a managed/production database that the
 * legacy schema migrations were not designed to touch.
 */
export function createDb(databaseUrl: string): Db {
  const pool = new Pool({ connectionString: databaseUrl });
  return drizzle(pool, { schema });
}

/**
 * Returns the underlying `pg` connection pool for a handle so callers (the
 * graceful-shutdown path, tests) can close it. Drizzle exposes the client it
 * was built with on `$client`.
 */
export function getPool(db: Db): Pool {
  return (db as Db & { $client: Pool }).$client;
}

/** Closes the connection pool backing a handle. Idempotent-safe to await once. */
export async function closeDb(db: Db): Promise<void> {
  await getPool(db).end();
}
