import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { schema } from "../dist/db/schema.js";
import { createPostgresArtifactStore } from "../dist/runner/artifact-store.js";
import { runCleanup } from "../dist/scheduler/cleanup.js";
import { createLogger } from "../dist/utils/logger.js";

// Exercises the cleanup sweep (expired run_artifacts + sessions + consumed/expired
// magic-link tokens) against a live Postgres. SKIPPED unless DATABASE_URL is set
// and reachable, matching the other live-pg suites.
//
// SAFETY: point DATABASE_URL only at a local/ephemeral Postgres. This creates an
// isolated throwaway schema and drops it afterwards; it never touches the
// `public` schema or any production data.

const DATABASE_URL = process.env.DATABASE_URL;
const TEST_SCHEMA = `evisaflow_cleanup_${process.pid}_${Date.now().toString(36)}`;

// Slice of the live schema (through migration 006) the cleanup sweep touches:
// run_artifacts (+ its FK chain), sessions, magic_link_tokens.
const SCHEMA_DDL = `
CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id       BIGINT UNIQUE,
  email             TEXT UNIQUE,
  email_verified    BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_identity_present_check
    CHECK (telegram_id IS NOT NULL OR email IS NOT NULL)
);

CREATE TABLE family_members (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name          TEXT NOT NULL,
  custody               TEXT NOT NULL DEFAULT 'server',
  encrypted_doc_number  TEXT,
  encrypted_secret      BYTEA,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  sort_order            SMALLINT NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_member_id  UUID NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  trigger           TEXT NOT NULL DEFAULT 'manual',
  status            TEXT NOT NULL DEFAULT 'pending',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE run_artifacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID REFERENCES runs(id) ON DELETE CASCADE,
  kind        TEXT CHECK (kind IN ('evisa_pdf', 'checker_html', 'checker_pdf')),
  filename    TEXT,
  sealed_alg  TEXT,
  storage     TEXT NOT NULL DEFAULT 'db' CHECK (storage IN ('db', 'disk')),
  bytes       BYTEA,
  path        TEXT,
  byte_length INT,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE magic_link_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
`;

async function probeDatabase() {
  if (!DATABASE_URL) return "DATABASE_URL is not set";
  const probe = new Pool({
    connectionString: DATABASE_URL,
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

async function ensurePgcrypto(client) {
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
  } catch (err) {
    const code = err?.code;
    if (code !== "23505" && code !== "42710") throw err;
  }
}

const skip = await probeDatabase();

describe("cleanup sweep (Postgres)", { skip: skip ?? false }, () => {
  let bootstrap;
  let pool;
  let db;
  let store;
  const log = createLogger();

  before(async () => {
    bootstrap = new Pool({ connectionString: DATABASE_URL });
    await ensurePgcrypto(bootstrap);
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${TEST_SCHEMA}"`);

    pool = new Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${TEST_SCHEMA}`,
    });
    await pool.query(SCHEMA_DDL);
    db = drizzle(pool, { schema });
    store = createPostgresArtifactStore(db, { ttlMs: 60_000 });
  });

  after(async () => {
    if (pool) await pool.end().catch(() => {});
    if (bootstrap) {
      await bootstrap
        .query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`)
        .catch(() => {});
      await bootstrap.end().catch(() => {});
    }
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE run_artifacts, magic_link_tokens, sessions, runs, family_members, users RESTART IDENTITY CASCADE"
    );
  });

  let nextTelegramId = 5000;
  async function makeUser() {
    nextTelegramId += 1;
    const row = (
      await pool.query("INSERT INTO users (telegram_id) VALUES ($1) RETURNING id", [
        nextTelegramId,
      ])
    ).rows[0];
    return row.id;
  }

  async function makeRun(userId) {
    const member = (
      await pool.query(
        "INSERT INTO family_members (user_id, display_name, encrypted_doc_number) VALUES ($1, 'M', 'x') RETURNING id",
        [userId]
      )
    ).rows[0];
    const run = (
      await pool.query(
        "INSERT INTO runs (user_id, family_member_id) VALUES ($1, $2) RETURNING id",
        [userId, member.id]
      )
    ).rows[0];
    return run.id;
  }

  it("deletes expired artifacts, sessions, and consumed/expired tokens; keeps the rest", async () => {
    const userId = await makeUser();
    const runId = await makeRun(userId);

    // --- run_artifacts: one live (future expiry), two expired (past) ---
    await pool.query(
      `INSERT INTO run_artifacts (run_id, kind, sealed_alg, bytes, byte_length, expires_at)
       VALUES
         ($1, 'evisa_pdf', 'box_seal', $2, 3, now() + interval '1 hour'),
         ($1, 'evisa_pdf', 'box_seal', $2, 3, now() - interval '1 hour'),
         ($1, 'checker_html', 'box_seal', $2, 3, now() - interval '5 minutes')`,
      [runId, Buffer.from([1, 2, 3])]
    );

    // --- sessions: one live, one expired ---
    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES
         ($1, 'live-session', now() + interval '1 day'),
         ($1, 'expired-session', now() - interval '1 minute')`,
      [userId]
    );

    // --- magic_link_tokens: live-unconsumed (keep), expired (delete),
    //     consumed-but-not-expired (delete because single-use is spent) ---
    await pool.query(
      `INSERT INTO magic_link_tokens (email, token_hash, consumed_at, expires_at)
       VALUES
         ('a@example.com', 'live-token', NULL, now() + interval '10 minutes'),
         ('b@example.com', 'expired-token', NULL, now() - interval '1 minute'),
         ('c@example.com', 'consumed-token', now() - interval '5 minutes', now() + interval '10 minutes')`
    );

    const removed = await runCleanup(db, store, log);
    assert.deepEqual(removed, { artifacts: 2, sessions: 1, magicLinkTokens: 2 });

    // Survivors are exactly the live/unconsumed rows.
    const artifacts = (await pool.query("SELECT count(*)::int AS n FROM run_artifacts"))
      .rows[0].n;
    assert.equal(artifacts, 1, "only the live artifact remains");

    const sessions = (await pool.query("SELECT token_hash FROM sessions")).rows.map(
      (r) => r.token_hash
    );
    assert.deepEqual(sessions, ["live-session"]);

    const tokens = (
      await pool.query("SELECT token_hash FROM magic_link_tokens ORDER BY token_hash")
    ).rows.map((r) => r.token_hash);
    assert.deepEqual(tokens, ["live-token"]);

    // Idempotent: a second sweep removes nothing.
    assert.deepEqual(await runCleanup(db, store, log), {
      artifacts: 0,
      sessions: 0,
      magicLinkTokens: 0,
    });
  });

  it("a sweep with nothing expired removes nothing", async () => {
    const userId = await makeUser();
    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, 'fresh', now() + interval '1 day')`,
      [userId]
    );
    const removed = await runCleanup(db, store, log);
    assert.deepEqual(removed, { artifacts: 0, sessions: 0, magicLinkTokens: 0 });
    const n = (await pool.query("SELECT count(*)::int AS n FROM sessions")).rows[0].n;
    assert.equal(n, 1);
  });
});
