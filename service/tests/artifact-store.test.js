import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { addFamilyMember } from "../dist/db/family-members.js";
import { insertRun } from "../dist/db/runs.js";
import { schema } from "../dist/db/schema.js";
import { upsertUser } from "../dist/db/users.js";
import { createPostgresArtifactStore } from "../dist/runner/artifact-store.js";

// Exercises the real Postgres-backed ArtifactStore against a live database.
// SKIPPED unless DATABASE_URL is set and reachable, so the suite stays green in
// environments without a database (matching db.test.js).
//
// SAFETY: point DATABASE_URL only at a local/ephemeral Postgres. This creates an
// isolated throwaway schema and drops it afterwards; it never touches the
// `public` schema or any production data.

const DATABASE_URL = process.env.DATABASE_URL;
const TEST_SCHEMA = `evisaflow_artifacts_${process.pid}_${Date.now().toString(36)}`;

// Minimal slice of the live schema (through migration 006) needed by these
// tests: run_artifacts and the FK chain it hangs off (runs → family_members →
// users), created inside the isolated test schema.
const SCHEMA_DDL = `
CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id       BIGINT UNIQUE,
  telegram_handle   TEXT,
  first_name        TEXT,
  email             TEXT UNIQUE,
  email_verified    BOOLEAN NOT NULL DEFAULT false,
  display_name      TEXT,
  next_scheduled_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_identity_present_check
    CHECK (telegram_id IS NOT NULL OR email IS NOT NULL)
);

CREATE TABLE family_members (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name          TEXT NOT NULL,
  custody               TEXT NOT NULL DEFAULT 'server' CHECK (custody IN ('server', 'client')),
  auth_type             TEXT CHECK (auth_type IN ('passport', 'nationalId', 'brc', 'ukvi')),
  encrypted_doc_number  TEXT,
  dob_day               SMALLINT,
  dob_month             SMALLINT,
  dob_year              SMALLINT,
  preferred_2fa_method  TEXT DEFAULT 'sms',
  purpose               TEXT DEFAULT 'immigration_status_other',
  encrypted_secret      BYTEA,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  sort_order            SMALLINT NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT family_members_custody_secret_check CHECK (
    (custody = 'server' AND encrypted_doc_number IS NOT NULL)
    OR
    (custody = 'client' AND encrypted_secret IS NOT NULL)
  )
);

CREATE TABLE runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_member_id  UUID NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  trigger           TEXT NOT NULL DEFAULT 'manual',
  status            TEXT NOT NULL DEFAULT 'pending',
  encrypted_share_code TEXT,
  share_code_alg    TEXT,
  custody           TEXT,
  valid_until       TIMESTAMPTZ,
  error_code        TEXT,
  error_message     TEXT,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
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
`;

/**
 * Decides whether a live database is available. Returns a skip reason string
 * when it is not (so the suite is reported as skipped, never failed).
 */
async function probeDatabase() {
  if (!DATABASE_URL) {
    return "DATABASE_URL is not set";
  }
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

/**
 * Ensures the `pgcrypto` extension exists (for `gen_random_uuid()` defaults).
 *
 * Extensions are database-global, not schema-scoped, so the parallel live-pg
 * test files all target the same one. `CREATE EXTENSION IF NOT EXISTS` is NOT
 * race-safe in Postgres: two concurrent creators both pass the existence check
 * and one then trips the `pg_extension` unique index (SQLSTATE 23505) or a
 * duplicate-object error (42710). We tolerate exactly those races — the
 * extension is present either way — but rethrow anything else.
 */
async function ensurePgcrypto(client) {
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
  } catch (err) {
    const code = err?.code;
    if (code !== "23505" && code !== "42710") throw err;
  }
}

/** Builds a byte-oriented SealedArtifactRef carrying the given sealed bytes. */
function sealedRef(overrides = {}) {
  const bytes = overrides.bytes ?? randomBytes(64);
  return {
    kind: "pdf",
    filename: "EVISA_Test.pdf",
    contentType: "application/pdf",
    byteLength: bytes.length,
    sealed: { alg: "box_seal", bytes: new Uint8Array(bytes) },
    ...overrides,
    // Keep sealed/byteLength consistent if only `bytes` was overridden.
    ...(overrides.bytes
      ? {
          byteLength: overrides.bytes.length,
          sealed: { alg: "box_seal", bytes: new Uint8Array(overrides.bytes) },
        }
      : {}),
  };
}

const skip = await probeDatabase();

describe("ArtifactStore (Postgres)", { skip: skip ?? false }, () => {
  let bootstrap;
  let pool;
  let db;
  let store;

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
    await pool.query("TRUNCATE run_artifacts, runs, family_members, users CASCADE");
  });

  let nextTelegramId = 1000;
  async function makeRun() {
    // Monotonic ids keep users distinct within a test (rows are truncated between
    // tests). upsertUser needs the full arg list — handle + schedule interval.
    nextTelegramId += 1;
    const user = await upsertUser(db, nextTelegramId, "Ada", "ada_handle", 30);
    const member = await addFamilyMember(db, {
      user_id: user.id,
      display_name: "Member",
      auth_type: "passport",
      encrypted_doc_number: "ciphertext",
      dob_day: 1,
      dob_month: 2,
      dob_year: 1990,
      preferred_2fa_method: "sms",
      purpose: "immigration_status_other",
    });
    return insertRun(db, {
      user_id: user.id,
      family_member_id: member.id,
      trigger: "manual",
    });
  }

  it("putSealed → getSealed round-trips the exact sealed bytes", async () => {
    const run = await makeRun();
    const bytes = randomBytes(128);
    const ref = sealedRef({ bytes, kind: "pdf", filename: "EVISA_Round.pdf" });

    const { id } = await store.putSealed(run.id, ref);
    assert.equal(typeof id, "string");

    const fetched = await store.getSealed(run.id, id);
    assert.ok(fetched, "artifact should be found");
    assert.equal(fetched.id, id);
    assert.equal(fetched.runId, run.id);
    // 'pdf' is recorded as 'evisa_pdf' in the run_artifacts.kind domain.
    assert.equal(fetched.kind, "evisa_pdf");
    assert.equal(fetched.filename, "EVISA_Round.pdf");
    assert.equal(fetched.sealedAlg, "box_seal");
    assert.equal(fetched.byteLength, bytes.length);
    assert.ok(Buffer.isBuffer(fetched.bytes));
    // The sealed bytes come back byte-for-byte identical (store never mutates).
    assert.ok(fetched.bytes.equals(bytes), "sealed bytes round-trip unchanged");
  });

  it("getSealed is scoped to the run (wrong run id returns null)", async () => {
    const run = await makeRun();
    const other = await makeRun();
    const { id } = await store.putSealed(run.id, sealedRef());

    assert.equal(await store.getSealed(other.id, id), null);
    assert.equal(
      await store.getSealed(run.id, "00000000-0000-0000-0000-000000000000"),
      null
    );
  });

  it("listForRun returns a run's artifacts oldest first, only that run's", async () => {
    const run = await makeRun();
    const other = await makeRun();

    await store.putSealed(run.id, sealedRef({ kind: "pdf", filename: "a.pdf" }));
    await store.putSealed(
      run.id,
      sealedRef({ kind: "checker_html", filename: "b.html" })
    );
    await store.putSealed(other.id, sealedRef({ kind: "pdf", filename: "other.pdf" }));

    const listed = await store.listForRun(run.id);
    assert.equal(listed.length, 2);
    assert.deepEqual(
      listed.map((a) => a.filename),
      ["a.pdf", "b.html"],
      "ordered by creation (insertion) order"
    );
    assert.deepEqual(
      listed.map((a) => a.kind),
      ["evisa_pdf", "checker_html"]
    );
    // Every byte payload survived storage.
    for (const a of listed) {
      assert.ok(Buffer.isBuffer(a.bytes) && a.bytes.length === 64);
    }
  });

  it("deleteExpired removes only artifacts past their expiry, returns the count", async () => {
    const run = await makeRun();

    // A live artifact via the store's own TTL (expires_at ~60s in the future).
    const live = await store.putSealed(run.id, sealedRef({ filename: "live.pdf" }));

    // Two already-expired artifacts inserted directly with past expiry.
    await pool.query(
      `INSERT INTO run_artifacts (run_id, kind, filename, sealed_alg, bytes, byte_length, expires_at)
       VALUES
         ($1, 'evisa_pdf', 'old1.pdf', 'box_seal', $2, 3, now() - interval '2 hours'),
         ($1, 'evisa_pdf', 'old2.pdf', 'box_seal', $2, 3, now() - interval '1 minute')`,
      [run.id, Buffer.from([1, 2, 3])]
    );

    const before = (await pool.query("SELECT count(*)::int AS n FROM run_artifacts"))
      .rows[0].n;
    assert.equal(before, 3);

    const removed = await store.deleteExpired(new Date());
    assert.equal(removed, 2, "both expired rows deleted");

    const remaining = await store.listForRun(run.id);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, live.id, "the live artifact survives");

    // Idempotent: a second sweep finds nothing left to delete.
    assert.equal(await store.deleteExpired(new Date()), 0);
  });
});
