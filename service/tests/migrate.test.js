import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { runMigrations } from "../dist/db/migrate.js";

// Exercises the real migration runner against a live Postgres. SKIPPED unless
// DATABASE_URL is set and reachable, so the suite stays green without a database
// (local dev / CI without a service container).
//
// SAFETY: point DATABASE_URL only at a local/ephemeral Postgres. Each test
// creates and drops its own throwaway DATABASE (named off the pid), so it never
// touches the database named in DATABASE_URL or any production data. The runner
// connects on the default search_path, so isolation is by database, not schema.

const DATABASE_URL = process.env.DATABASE_URL;

// A no-op logger keeps test output clean while satisfying the runner's Logger arg.
const silentLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  fatal() {},
  trace() {},
};

/** Returns a connection string pointing at `dbName` on the same server. */
function urlForDatabase(dbName) {
  const url = new URL(DATABASE_URL);
  url.pathname = `/${dbName}`;
  return url.href;
}

/** Returns a maintenance connection string (the default `postgres` database). */
function maintenanceUrl() {
  return urlForDatabase("postgres");
}

/** True if a live database is reachable; returns a skip reason string otherwise. */
async function probeDatabase() {
  if (!DATABASE_URL) return "DATABASE_URL is not set";
  const probe = new Pool({
    connectionString: maintenanceUrl(),
    connectionTimeoutMillis: 2000,
  });
  try {
    await probe.query("select 1");
    return null;
  } catch (err) {
    return `database unreachable: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    await probe.end().catch(() => {});
  }
}

/** Reads a migration SQL file from the source `migrations/` directory. */
async function readMigration(filename) {
  return readFile(
    fileURLToPath(new URL(`../migrations/${filename}`, import.meta.url)),
    "utf8"
  );
}

const skip = await probeDatabase();

describe("db migrate runner", { skip: skip ?? false }, () => {
  let admin;
  // Unique per worker process so parallel/repeat runs never collide.
  const suffix = `${process.pid}_${Date.now().toString(36)}`;
  const dbNames = new Set();

  before(() => {
    admin = new Pool({ connectionString: maintenanceUrl() });
  });

  after(async () => {
    if (admin) {
      for (const name of dbNames) {
        await admin
          .query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
          .catch(() => {});
      }
      await admin.end().catch(() => {});
    }
  });

  /** Creates a fresh empty database and returns its connection URL. */
  async function freshDatabase(label) {
    const name = `evisaflow_migtest_${label}_${suffix}`;
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await admin.query(`CREATE DATABASE "${name}"`);
    dbNames.add(name);
    return urlForDatabase(name);
  }

  /** Connects to a database, runs `fn(pool)`, then closes the pool. */
  async function withPool(url, fn) {
    const pool = new Pool({ connectionString: url });
    try {
      return await fn(pool);
    } finally {
      await pool.end().catch(() => {});
    }
  }

  async function tableExists(pool, table) {
    const { rows } = await pool.query(
      `SELECT to_regclass('public.' || $1) IS NOT NULL AS present`,
      [table]
    );
    return rows[0]?.present === true;
  }

  async function columnNullability(pool, table, column) {
    const { rows } = await pool.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column]
    );
    return rows[0]?.is_nullable ?? null;
  }

  it("fresh database: applies all migrations including 004 and is idempotent", async () => {
    const url = await freshDatabase("fresh");

    const first = await runMigrations(url, silentLog);
    assert.deepEqual(first.baselined, [], "nothing to baseline on a truly empty DB");
    assert.deepEqual(
      first.applied,
      ["001", "002", "003", "004"],
      "every migration runs on a fresh DB in ascending order"
    );

    await withPool(url, async (pool) => {
      // Core tables from 001-003.
      for (const t of ["users", "family_members", "runs", "run_events"]) {
        assert.equal(await tableExists(pool, t), true, `${t} created`);
      }
      // 004 tables.
      for (const t of [
        "user_vault",
        "sessions",
        "magic_link_tokens",
        "schema_migrations",
      ]) {
        assert.equal(await tableExists(pool, t), true, `${t} created`);
      }
      // 004 columns on users.
      for (const c of ["email", "email_verified", "display_name"]) {
        assert.notEqual(
          await columnNullability(pool, "users", c),
          null,
          `users.${c} added`
        );
      }
      // 004 relaxes NOT NULL on telegram_id and first_name.
      assert.equal(await columnNullability(pool, "users", "telegram_id"), "YES");
      assert.equal(await columnNullability(pool, "users", "first_name"), "YES");
      // email_verified stays NOT NULL (has a default).
      assert.equal(await columnNullability(pool, "users", "email_verified"), "NO");

      // Identity CHECK is enforced: a user with neither identity is rejected.
      await assert.rejects(
        () => pool.query("INSERT INTO users (telegram_id, email) VALUES (NULL, NULL)"),
        (err) => /users_identity_present_check/.test(String(err))
      );

      const ledger = await pool.query(
        "SELECT version FROM schema_migrations ORDER BY version"
      );
      assert.deepEqual(
        ledger.rows.map((r) => r.version),
        ["001", "002", "003", "004"]
      );
    });

    // Second run is a no-op: nothing applied, nothing baselined.
    const second = await runMigrations(url, silentLog);
    assert.deepEqual(second.baselined, []);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.alreadyApplied, ["001", "002", "003", "004"]);
  });

  it("baseline: pre-existing 001-003 schema is recorded, only 004 runs, data preserved", async () => {
    const url = await freshDatabase("baseline");

    // Simulate an existing Supabase database: apply 001-003 raw, with NO ledger.
    await withPool(url, async (pool) => {
      await pool.query(await readMigration("001_initial_schema.sql"));
      await pool.query(await readMigration("002_bot_runtime_hardening.sql"));
      await pool.query(await readMigration("003_drop_plaintext_share_code.sql"));
      // A sentinel row proves 001's `CREATE TABLE users` is NOT re-run (which
      // would error) and survives the migrate call untouched.
      await pool.query(
        "INSERT INTO users (telegram_id, first_name) VALUES (777001, 'Baseline')"
      );
      assert.equal(await tableExists(pool, "schema_migrations"), false, "no ledger yet");
    });

    const result = await runMigrations(url, silentLog);
    assert.deepEqual(
      result.baselined,
      ["001", "002", "003"],
      "pre-ledger versions recorded without re-running"
    );
    assert.deepEqual(result.applied, ["004"], "only the new migration runs");

    await withPool(url, async (pool) => {
      // Sentinel survived and display_name was backfilled from first_name.
      const { rows } = await pool.query(
        "SELECT first_name, display_name, email_verified FROM users WHERE telegram_id = 777001"
      );
      assert.equal(rows.length, 1, "sentinel row preserved (001 was not re-run)");
      assert.equal(rows[0].first_name, "Baseline");
      assert.equal(rows[0].display_name, "Baseline", "display_name backfilled");
      assert.equal(rows[0].email_verified, false);

      // 004 tables now present.
      for (const t of ["user_vault", "sessions", "magic_link_tokens"]) {
        assert.equal(await tableExists(pool, t), true, `${t} created by 004`);
      }

      const ledger = await pool.query(
        "SELECT version FROM schema_migrations ORDER BY version"
      );
      assert.deepEqual(
        ledger.rows.map((r) => r.version),
        ["001", "002", "003", "004"]
      );
    });

    // Re-running after a baseline is a no-op.
    const again = await runMigrations(url, silentLog);
    assert.deepEqual(again.baselined, []);
    assert.deepEqual(again.applied, []);
  });
});
