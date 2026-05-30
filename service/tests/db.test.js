import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  addFamilyMember,
  countActiveFamilyMembers,
  deactivateFamilyMember,
  getActiveFamilyMembers,
  getFamilyMemberById,
} from "../dist/db/family-members.js";
import {
  insertRun,
  insertRunEvent,
  markNonTerminalRunsInterrupted,
  RunStatusConflictError,
  updateRunStatus,
} from "../dist/db/runs.js";
import { schema } from "../dist/db/schema.js";
import {
  advanceSchedule,
  getUserByTelegramId,
  getUsersDueForSchedule,
  upsertUser,
} from "../dist/db/users.js";

// These tests exercise the real Drizzle + pg implementation against a live
// Postgres. They are SKIPPED unless DATABASE_URL is set and reachable, so the
// suite stays green in environments without a database (CI without a service
// container, local dev without Postgres).
//
// SAFETY: point DATABASE_URL only at a local/ephemeral Postgres. Each run
// creates an isolated throwaway schema and drops it afterwards; it never touches
// the `public` schema or any production data.

const DATABASE_URL = process.env.DATABASE_URL;
const TEST_SCHEMA = `evisaflow_dbtest_${process.pid}_${Date.now().toString(36)}`;

// Final shape of the live schema after migrations 001 + 002 + 003 + 004, created
// inside the isolated test schema (search_path is pinned to it at the pool).
// The users table carries the 004 web-identity columns (telegram_id/first_name
// now nullable; email/email_verified/display_name added) so the db/users.ts
// selects, which now reference those columns, resolve here.
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

-- Mirrors the live schema through migration 005: custody + encrypted_secret,
-- cleartext-ish columns nullable, and the per-custody integrity CHECK.
CREATE TABLE family_members (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name          TEXT NOT NULL,
  custody               TEXT NOT NULL DEFAULT 'server' CHECK (custody IN ('server', 'client')),
  auth_type             TEXT CHECK (auth_type IN ('passport', 'nationalId', 'brc', 'ukvi')),
  encrypted_doc_number  TEXT,
  dob_day               SMALLINT CHECK (dob_day BETWEEN 1 AND 31),
  dob_month             SMALLINT CHECK (dob_month BETWEEN 1 AND 12),
  dob_year              SMALLINT CHECK (dob_year BETWEEN 1900 AND 2100),
  preferred_2fa_method  TEXT DEFAULT 'sms' CHECK (preferred_2fa_method IN ('sms', 'email')),
  purpose               TEXT DEFAULT 'immigration_status_other'
                        CHECK (purpose IN ('right_to_work', 'right_to_rent', 'immigration_status_other')),
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

CREATE OR REPLACE FUNCTION check_max_family_members()
  RETURNS TRIGGER AS $$
BEGIN
  IF (
    SELECT count(*) FROM family_members
    WHERE user_id = NEW.user_id AND is_active = true
  ) >= 6 THEN
    RAISE EXCEPTION 'Maximum 6 active family members per user';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_max_family_members
  BEFORE INSERT ON family_members
  FOR EACH ROW EXECUTE FUNCTION check_max_family_members();

CREATE TABLE runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_member_id  UUID NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  trigger           TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'scheduled')),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'awaiting_2fa', 'success', 'failed', 'cancelled', 'interrupted')),
  encrypted_share_code TEXT,
  share_code_alg    TEXT CHECK (share_code_alg IN ('aesgcm', 'box_seal')),
  custody           TEXT,
  valid_until       TIMESTAMPTZ,
  error_code        TEXT,
  error_message     TEXT,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_runs_one_active_per_member
  ON runs(user_id, family_member_id)
  WHERE status IN ('pending', 'running', 'awaiting_2fa');

CREATE TABLE run_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  phase       TEXT,
  page_kind   TEXT,
  operation   TEXT,
  duration_ms DOUBLE PRECISION,
  step_id     TEXT,
  error_code  TEXT,
  message     TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sealed run outputs (migration 006). Mirrored so Drizzle selects referencing
-- run_artifacts resolve against the isolated test schema.
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

CREATE OR REPLACE FUNCTION update_updated_at()
  RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_family_members_updated_at
  BEFORE UPDATE ON family_members
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
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

/** True if `needle` appears in an error's message or anywhere in its cause chain. */
function causeChainIncludes(err, needle) {
  let current = err;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const message = current instanceof Error ? current.message : String(current);
    if (message.includes(needle)) return true;
    current = current?.cause;
  }
  return false;
}

const skip = await probeDatabase();

describe("db (Drizzle + pg)", { skip: skip ?? false }, () => {
  let bootstrap;
  let pool;
  let db;

  before(async () => {
    // Bootstrap connection on the default search_path to create the isolated
    // test schema, then build a pool pinned to it for everything else.
    bootstrap = new Pool({ connectionString: DATABASE_URL });
    // pgcrypto (for gen_random_uuid()) is database-global, so parallel live-pg
    // test files race to create it. `IF NOT EXISTS` is not race-safe in Postgres:
    // tolerate the concurrent-duplicate errors (unique-index 23505 / 42710) and
    // rethrow anything else — the extension is present either way.
    try {
      await bootstrap.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    } catch (err) {
      if (err?.code !== "23505" && err?.code !== "42710") throw err;
    }
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS "${TEST_SCHEMA}"`);

    pool = new Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${TEST_SCHEMA}`,
    });
    await pool.query(SCHEMA_DDL);
    db = drizzle(pool, { schema });
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
    // Truncate between tests for isolation; CASCADE clears dependents.
    await pool.query(
      "TRUNCATE run_events, runs, family_members, users RESTART IDENTITY CASCADE"
    );
  });

  async function makeUser(telegramId = 1001) {
    return upsertUser(db, telegramId, "Ada", "ada_handle", 30);
  }

  async function makeMember(userId, overrides = {}) {
    return addFamilyMember(db, {
      user_id: userId,
      display_name: "Member",
      auth_type: "passport",
      encrypted_doc_number: "ciphertext",
      dob_day: 1,
      dob_month: 2,
      dob_year: 1990,
      preferred_2fa_method: "sms",
      purpose: "immigration_status_other",
      ...overrides,
    });
  }

  it("upsertUser inserts then updates on telegram_id conflict, ISO timestamps", async () => {
    const created = await makeUser(2002);
    assert.equal(created.telegram_id, 2002);
    assert.equal(created.first_name, "Ada");
    assert.equal(created.telegram_handle, "ada_handle");
    assert.equal(typeof created.created_at, "string");
    assert.equal(typeof created.next_scheduled_at, "string");
    // Timestamps surface as ISO strings, parseable as dates.
    assert.ok(!Number.isNaN(Date.parse(created.created_at)));
    assert.ok(!Number.isNaN(Date.parse(created.next_scheduled_at)));

    const updated = await upsertUser(db, 2002, "Grace", "grace_handle", 60);
    assert.equal(updated.id, created.id, "same row updated on conflict");
    assert.equal(updated.first_name, "Grace");
    assert.equal(updated.telegram_handle, "grace_handle");

    const fetched = await getUserByTelegramId(db, 2002);
    assert.equal(fetched.id, created.id);
    assert.equal(fetched.first_name, "Grace");

    assert.equal(await getUserByTelegramId(db, 999999), null);
  });

  it("getUsersDueForSchedule + advanceSchedule honour next_scheduled_at", async () => {
    const user = await makeUser(3003);
    // Freshly created users are scheduled in the future → not due yet.
    let due = await getUsersDueForSchedule(db);
    assert.equal(
      due.some((u) => u.id === user.id),
      false
    );

    // Force the schedule into the past via a direct update, then expect it due.
    await pool.query("UPDATE users SET next_scheduled_at = now() - interval '1 day'");
    due = await getUsersDueForSchedule(db);
    assert.equal(
      due.some((u) => u.id === user.id),
      true
    );

    await advanceSchedule(db, user.id, 30);
    due = await getUsersDueForSchedule(db);
    assert.equal(
      due.some((u) => u.id === user.id),
      false,
      "advanceSchedule pushes next_scheduled_at into the future"
    );
  });

  it("family member CRUD: add, list active ordered, fetch by id, deactivate, count", async () => {
    const user = await makeUser();
    // addFamilyMember does not accept sort_order (matching the stable signature):
    // every member is created with the default sort_order = 0, so ordering by
    // sort_order is stable and ties fall back to insertion order.
    const a = await makeMember(user.id, { display_name: "A" });
    const b = await makeMember(user.id, { display_name: "B" });

    assert.equal(typeof a.created_at, "string");
    assert.equal(a.is_active, true);
    assert.equal(a.sort_order, 0);
    assert.equal(b.sort_order, 0);

    const active = await getActiveFamilyMembers(db, user.id);
    assert.deepEqual(
      active.map((m) => m.display_name),
      ["A", "B"],
      "ordered by sort_order ascending (default 0), then insertion order"
    );

    const fetched = await getFamilyMemberById(db, a.id, user.id);
    assert.equal(fetched.display_name, "A");
    // Cross-user ownership check returns null (member belongs to `user`, not `otherUser`).
    const otherUser = await makeUser(4004);
    assert.equal(await getFamilyMemberById(db, a.id, otherUser.id), null);

    assert.equal(await countActiveFamilyMembers(db, user.id), 2);
    await deactivateFamilyMember(db, a.id, user.id);
    assert.equal(await countActiveFamilyMembers(db, user.id), 1);
    const stillActive = await getActiveFamilyMembers(db, user.id);
    assert.deepEqual(
      stillActive.map((m) => m.display_name),
      ["B"]
    );
  });

  it("addFamilyMember enforces the max-6-active trigger", async () => {
    const user = await makeUser(5005);
    for (let i = 0; i < 6; i++) {
      await makeMember(user.id, { display_name: `M${i}` });
    }
    assert.equal(await countActiveFamilyMembers(db, user.id), 6);
    // The trigger raises a Postgres exception; Drizzle wraps it, so inspect the
    // whole cause chain for the trigger's message rather than the top message.
    await assert.rejects(
      () => makeMember(user.id, { display_name: "overflow" }),
      (err) => causeChainIncludes(err, "Maximum 6 active family members")
    );
    // The 7th insert was rejected: still exactly 6 active members.
    assert.equal(await countActiveFamilyMembers(db, user.id), 6);
  });

  it("insertRun dedups via the partial unique index (second active run throws)", async () => {
    const user = await makeUser(6006);
    const member = await makeMember(user.id);

    const run = await insertRun(db, {
      user_id: user.id,
      family_member_id: member.id,
      trigger: "manual",
    });
    assert.equal(run.status, "pending");
    assert.equal(typeof run.started_at, "string");
    assert.equal(typeof run.created_at, "string");

    // A second active run for the same member violates idx_runs_one_active_per_member.
    await assert.rejects(
      () =>
        insertRun(db, {
          user_id: user.id,
          family_member_id: member.id,
          trigger: "manual",
        }),
      (err) => err instanceof Error
    );

    // Once the first run reaches a terminal status, a new run is allowed again.
    await updateRunStatus(db, run.id, { status: "success" });
    const second = await insertRun(db, {
      user_id: user.id,
      family_member_id: member.id,
      trigger: "scheduled",
    });
    assert.equal(second.status, "pending");
  });

  it("updateRunStatus: terminal sets completed_at, requireActive gating, throwOnConflict", async () => {
    const user = await makeUser(7007);
    const member = await makeMember(user.id);
    const run = await insertRun(db, {
      user_id: user.id,
      family_member_id: member.id,
      trigger: "manual",
    });

    // Non-terminal transition: no completed_at yet.
    const toRunning = await updateRunStatus(db, run.id, { status: "running" });
    assert.equal(toRunning, true);
    let row = (
      await pool.query("SELECT status, completed_at FROM runs WHERE id = $1", [run.id])
    ).rows[0];
    assert.equal(row.status, "running");
    assert.equal(row.completed_at, null);

    // Terminal transition: auto-sets completed_at + persists optional fields.
    const toSuccess = await updateRunStatus(db, run.id, {
      status: "success",
      encrypted_share_code: "sealed-code",
      valid_until: "2030-01-01T00:00:00.000Z",
    });
    assert.equal(toSuccess, true);
    row = (
      await pool.query(
        "SELECT status, completed_at, encrypted_share_code, valid_until FROM runs WHERE id = $1",
        [run.id]
      )
    ).rows[0];
    assert.equal(row.status, "success");
    assert.notEqual(row.completed_at, null);
    assert.equal(row.encrypted_share_code, "sealed-code");
    assert.notEqual(row.valid_until, null);

    // requireActive default: a terminal run cannot transition again → false.
    const afterTerminal = await updateRunStatus(db, run.id, { status: "failed" });
    assert.equal(afterTerminal, false);

    // throwOnConflict surfaces RunStatusConflictError on the same no-op.
    await assert.rejects(
      () => updateRunStatus(db, run.id, { status: "failed" }, { throwOnConflict: true }),
      (err) => err instanceof RunStatusConflictError
    );

    // requireActive:false allows touching a terminal row.
    const forced = await updateRunStatus(
      db,
      run.id,
      { status: "failed", error_code: "X" },
      { requireActive: false }
    );
    assert.equal(forced, true);

    // Unknown run id reports no update.
    assert.equal(
      await updateRunStatus(db, "00000000-0000-0000-0000-000000000000", {
        status: "success",
      }),
      false
    );
  });

  it("insertRunEvent persists an event row", async () => {
    const user = await makeUser(8008);
    const member = await makeMember(user.id);
    const run = await insertRun(db, {
      user_id: user.id,
      family_member_id: member.id,
      trigger: "manual",
    });

    await insertRunEvent(db, {
      run_id: run.id,
      event_type: "phase",
      phase: "two_factor",
      message: "awaiting code",
      duration_ms: 12.5,
      metadata: { foo: "bar" },
    });

    const events = (
      await pool.query(
        "SELECT event_type, phase, message, duration_ms, metadata FROM run_events WHERE run_id = $1",
        [run.id]
      )
    ).rows;
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, "phase");
    assert.equal(events[0].phase, "two_factor");
    assert.equal(Number(events[0].duration_ms), 12.5);
    assert.deepEqual(events[0].metadata, { foo: "bar" });
  });

  it("markNonTerminalRunsInterrupted flips only active runs, respects runIds + staleBefore", async () => {
    const user = await makeUser(9009);
    const m1 = await makeMember(user.id, { display_name: "m1", sort_order: 1 });
    const m2 = await makeMember(user.id, { display_name: "m2", sort_order: 2 });
    const m3 = await makeMember(user.id, { display_name: "m3", sort_order: 3 });

    const active1 = await insertRun(db, {
      user_id: user.id,
      family_member_id: m1.id,
      trigger: "manual",
    });
    const active2 = await insertRun(db, {
      user_id: user.id,
      family_member_id: m2.id,
      trigger: "manual",
    });
    const done = await insertRun(db, {
      user_id: user.id,
      family_member_id: m3.id,
      trigger: "manual",
    });
    await updateRunStatus(db, done.id, { status: "success" });

    // Empty runIds short-circuits and changes nothing.
    await markNonTerminalRunsInterrupted(db, "noop", { runIds: [] });
    let r1 = (await pool.query("SELECT status FROM runs WHERE id = $1", [active1.id]))
      .rows[0];
    assert.equal(r1.status, "pending");

    // Targeted runIds only flips the named active run.
    await markNonTerminalRunsInterrupted(db, "restart", { runIds: [active1.id] });
    r1 = (
      await pool.query(
        "SELECT status, error_code, completed_at FROM runs WHERE id = $1",
        [active1.id]
      )
    ).rows[0];
    assert.equal(r1.status, "interrupted");
    assert.equal(r1.error_code, "SERVICE_RESTARTED");
    assert.notEqual(r1.completed_at, null);

    // active2 still pending (not in the runIds list); terminal run untouched.
    const r2 = (await pool.query("SELECT status FROM runs WHERE id = $1", [active2.id]))
      .rows[0];
    assert.equal(r2.status, "pending");
    const rDone = (await pool.query("SELECT status FROM runs WHERE id = $1", [done.id]))
      .rows[0];
    assert.equal(rDone.status, "success");

    // Blanket call interrupts every remaining active run.
    await markNonTerminalRunsInterrupted(db, "shutdown");
    const r2After = (
      await pool.query("SELECT status FROM runs WHERE id = $1", [active2.id])
    ).rows[0];
    assert.equal(r2After.status, "interrupted");

    // staleBefore in the past leaves freshly-started runs alone.
    const fresh = await insertRun(db, {
      user_id: user.id,
      family_member_id: m1.id,
      trigger: "manual",
    });
    await markNonTerminalRunsInterrupted(db, "stale", {
      staleBefore: new Date(Date.now() - 3_600_000),
    });
    const freshRow = (
      await pool.query("SELECT status FROM runs WHERE id = $1", [fresh.id])
    ).rows[0];
    assert.equal(freshRow.status, "pending", "fresh run is newer than staleBefore");
  });
});
