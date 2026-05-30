import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { createLogger, type Logger } from "../utils/logger.js";

/**
 * Baseline-safe Postgres migration runner for the service schema.
 *
 * It owns a `schema_migrations(version, applied_at)` ledger and applies every
 * `service/migrations/NNN_*.sql` whose version is not yet recorded, in ascending
 * filename order, each inside its own transaction. A second run is a no-op.
 *
 * BASELINE handling: the live Supabase database was created by migrations
 * 001–003 *before* this ledger existed. If the core tables already exist but the
 * ledger is empty, the pre-existing migrations are recorded as
 * already-applied WITHOUT re-running their DDL, so an existing database is never
 * re-migrated (and the live schema is never broken). Fresh self-host databases
 * have neither the tables nor the ledger, so every migration runs normally.
 *
 * SAFETY: only ever point `DATABASE_URL` at a local/ephemeral Postgres while
 * developing or testing. Never run this against the managed/production database.
 */

/** Versions that predate the `schema_migrations` ledger (the live baseline). */
const BASELINE_VERSIONS = ["001", "002", "003"] as const;

/** Core tables that prove a database was created by the baseline migrations. */
const BASELINE_TABLES = ["users", "family_members", "runs", "run_events"] as const;

interface MigrationFile {
  /** Numeric version prefix, e.g. `004`. */
  version: string;
  /** Full filename, e.g. `004_web_identity.sql`. */
  filename: string;
  /** Absolute path to the `.sql` file. */
  path: string;
}

/** Result of a {@link runMigrations} invocation, returned for logging/tests. */
export interface MigrateResult {
  /** Versions recorded as the baseline without running their DDL. */
  baselined: string[];
  /** Versions whose SQL was executed and recorded in this run. */
  applied: string[];
  /** Versions already present in the ledger before this run (skipped). */
  alreadyApplied: string[];
}

/**
 * Resolves the migrations directory. The `.sql` files are not compiled by `tsc`,
 * so they live next to `service/` in the source tree; from the built module
 * (`dist/db/migrate.js`) that is two levels up (`dist/db` → `dist` → `service`),
 * then `migrations`. The same relative layout holds for the un-built source
 * (`src/db` → `src` → `service`), so this resolves correctly either way.
 */
function migrationsDir(): string {
  return fileURLToPath(new URL("../../migrations", import.meta.url));
}

/** Lists migration files sorted by ascending version (filename) order. */
async function listMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files: MigrationFile[] = [];
  for (const filename of entries) {
    const match = /^(\d+)_.*\.sql$/.exec(filename);
    if (!match) continue;
    files.push({
      version: match[1],
      filename,
      path: fileURLToPath(new URL(`../../migrations/${filename}`, import.meta.url)),
    });
  }
  files.sort((a, b) => a.filename.localeCompare(b.filename, "en"));
  return files;
}

/** Creates the migration ledger if it does not already exist. */
async function ensureLedger(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/** Returns the set of versions already recorded in the ledger. */
async function appliedVersions(client: PoolClient): Promise<Set<string>> {
  const { rows } = await client.query<{ version: string }>(
    "SELECT version FROM schema_migrations"
  );
  return new Set(rows.map((row) => row.version));
}

/** True when all of the baseline core tables exist in the current database. */
async function baselineTablesExist(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query<{ present: number }>(
    `SELECT count(*)::int AS present
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])`,
    [[...BASELINE_TABLES]]
  );
  return (rows[0]?.present ?? 0) === BASELINE_TABLES.length;
}

/** Records a version in the ledger without running any DDL. */
async function recordVersion(client: PoolClient, version: string): Promise<void> {
  await client.query(
    "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
    [version]
  );
}

/**
 * Applies the migrations against a connection pool. Idempotent: only versions
 * missing from the ledger run, each in its own transaction. Exposed separately
 * from {@link runMigrations} so callers that already hold a pool (the service
 * boot path, tests) can reuse it without opening a second connection.
 */
export async function runMigrationsWithPool(
  pool: Pool,
  log: Logger
): Promise<MigrateResult> {
  const dir = migrationsDir();
  const migrations = await listMigrations(dir);
  const result: MigrateResult = { baselined: [], applied: [], alreadyApplied: [] };

  const setup = await pool.connect();
  let recorded: Set<string>;
  try {
    await ensureLedger(setup);
    recorded = await appliedVersions(setup);

    // Baseline: an existing database carries the core tables but no ledger rows.
    // Record the pre-ledger versions as applied without re-running their DDL.
    if (recorded.size === 0 && (await baselineTablesExist(setup))) {
      for (const version of BASELINE_VERSIONS) {
        await recordVersion(setup, version);
        recorded.add(version);
        result.baselined.push(version);
      }
      log.info({ versions: result.baselined }, "Recorded baseline migrations");
    }
  } finally {
    setup.release();
  }

  for (const migration of migrations) {
    if (recorded.has(migration.version)) {
      result.alreadyApplied.push(migration.version);
      continue;
    }
    const sqlText = await readFile(migration.path, "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sqlText);
      await recordVersion(client, migration.version);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`Migration ${migration.filename} failed`, { cause: err });
    } finally {
      client.release();
    }
    recorded.add(migration.version);
    result.applied.push(migration.version);
    log.info(
      { version: migration.version, file: migration.filename },
      "Applied migration"
    );
  }

  log.info(
    {
      baselined: result.baselined,
      applied: result.applied,
      alreadyApplied: result.alreadyApplied,
    },
    "Migrations up to date"
  );
  return result;
}

/**
 * Runs migrations against `databaseUrl`, owning the connection pool for the
 * duration (opened then closed). Use this from a one-shot context such as the
 * CLI entry point or a self-host startup hook.
 */
export async function runMigrations(
  databaseUrl: string,
  log: Logger = createLogger({ verbose: true })
): Promise<MigrateResult> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    return await runMigrationsWithPool(pool, log);
  } finally {
    await pool.end().catch(() => {});
  }
}

/** True when this module is the process entry point (`node dist/db/migrate.js`). */
function isCliEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return (
    import.meta.url === new URL(`file://${entry}`).href || entry.endsWith("migrate.js")
  );
}

if (isCliEntry()) {
  const databaseUrl = process.env.DATABASE_URL;
  const log = createLogger({ verbose: true });
  if (!databaseUrl) {
    log.fatal("DATABASE_URL is required to run migrations");
    process.exit(1);
  }
  runMigrations(databaseUrl, log)
    .then(() => process.exit(0))
    .catch((err) => {
      log.fatal({ err }, "Migration run failed");
      process.exit(1);
    });
}
