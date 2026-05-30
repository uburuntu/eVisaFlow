import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { schema } from "../dist/db/schema.js";
import { createInMemoryRunBus } from "../dist/runner/run-bus.js";
import { createWebServer } from "../dist/web/server.js";

// End-to-end run-lifecycle route tests via fastify.inject (no Playwright: the
// engine is a controllable STUB) plus a real-HTTP SSE test on app.listen({port:0}).
// DB-backed and SKIPPED unless DATABASE_URL is set and reachable (matching the
// other web tests).
//
// SAFETY: point DATABASE_URL only at a local/ephemeral Postgres. This creates an
// isolated throwaway schema and drops it afterwards; it never touches the
// `public` schema or any production data.

const DATABASE_URL = process.env.DATABASE_URL;
const TEST_SCHEMA = `evisaflow_runs_${process.pid}_${Date.now().toString(36)}`;
const BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"; // sample, not real
const BASE_URL = "https://app.test";

// Schema slice these routes touch: identity/session/vault (sign-in + recipient
// key) + family_members (ownership) + runs/run_events (lifecycle) + run_artifacts
// (sealed outputs). Mirrors migrations 001–006 for the touched tables.
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
CREATE TABLE user_vault (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  public_key           BYTEA NOT NULL,
  wrapped_private_key  BYTEA NOT NULL,
  kdf_salt             BYTEA NOT NULL,
  kdf_params           JSONB NOT NULL DEFAULT '{}'::jsonb,
  recovery_wrapped_key BYTEA,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
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
CREATE TABLE runs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_member_id     UUID NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  trigger              TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'scheduled')),
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'running', 'awaiting_2fa', 'success', 'failed', 'cancelled', 'interrupted')),
  encrypted_share_code TEXT,
  share_code_alg       TEXT CHECK (share_code_alg IN ('aesgcm', 'box_seal')),
  custody              TEXT,
  valid_until          TIMESTAMPTZ,
  error_code           TEXT,
  error_message        TEXT,
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
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

const log = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  fatal() {},
  trace() {},
  child: () => log,
};

/** Extracts the session cookie value from a response's Set-Cookie header(s). */
function sessionCookieFromResponse(res) {
  const raw = res.headers["set-cookie"];
  const headers = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const h of headers) {
    if (h.startsWith("evisa_session=")) {
      const value = h.slice("evisa_session=".length, h.indexOf(";"));
      return `evisa_session=${value}`;
    }
  }
  return null;
}

/**
 * Drains complete SSE records (separated by a blank line) from a rolling buffer.
 * Returns the parsed records and the unconsumed remainder. Each record is split
 * into its `id:`/`data:` lines so callers can read both; comment-only records
 * (heartbeats, the priming `: connected`) have no `data` and are skipped here.
 */
function drainSseRecords(buffer) {
  const records = [];
  let rest = buffer;
  for (;;) {
    const idx = rest.indexOf("\n\n");
    if (idx === -1) break;
    const record = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const lines = record.split("\n");
    const idLine = lines.find((l) => l.startsWith("id:"));
    const dataLine = lines.find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    records.push({
      id: idLine ? Number.parseInt(idLine.slice("id:".length).trim(), 10) : undefined,
      event: JSON.parse(dataLine.slice("data:".length).trim()),
    });
  }
  return { records, rest };
}

/**
 * A controllable stub RunEngine — NO Playwright. Backed by a real in-memory run
 * bus so SSE subscribe/backlog/terminal semantics are exercised end-to-end. The
 * test drives a run by calling `emit(runId, event)`; `enqueueRun` records its
 * input so assertions can verify the inline applicant was passed through (and
 * confirm it was never persisted/logged elsewhere). `submitCode`/`cancel` record
 * calls and return canned results the test sets per-run.
 */
function createStubEngine() {
  const bus = createInMemoryRunBus({ terminalGraceMs: 1000 });
  const enqueued = [];
  const submitCalls = [];
  const cancelCalls = [];
  // Per-run canned return values for submitCode/cancel; default false.
  const submitResults = new Map();
  const cancelResults = new Map();
  let acceptNext = true;

  return {
    bus,
    enqueued,
    submitCalls,
    cancelCalls,
    setAcceptNext(v) {
      acceptNext = v;
    },
    setSubmitResult(runId, v) {
      submitResults.set(runId, v);
    },
    setCancelResult(runId, v) {
      cancelResults.set(runId, v);
    },
    emit(runId, event) {
      bus.publish(runId, event);
    },
    // --- RunEngine interface ---
    enqueueRun(input) {
      enqueued.push(input);
      if (!acceptNext) {
        return { accepted: false, runId: input.runId, position: 0, reason: "duplicate" };
      }
      return { accepted: true, runId: input.runId, position: 0 };
    },
    submitCode(runId, code) {
      submitCalls.push({ runId, code });
      return submitResults.get(runId) ?? false;
    },
    cancel(runId, reason) {
      cancelCalls.push({ runId, reason });
      return cancelResults.get(runId) ?? false;
    },
    subscribe(runId) {
      return bus.subscribe(runId);
    },
    getSnapshot(runId) {
      return bus.snapshot(runId);
    },
  };
}

const skip = await probeDatabase();

describe("web run lifecycle routes (fastify.inject + SSE)", {
  skip: skip ?? false,
}, () => {
  let bootstrap;
  let pool;
  let db;
  let app;
  let engine;
  let lastMagicLink;
  let canCreateRun = true;
  // Fastify can only `listen` once; the SSE tests share a single real listener,
  // started lazily on first use and reused thereafter.
  let listenPort;
  async function ensureListening() {
    if (listenPort === undefined) {
      await app.listen({ port: 0, host: "127.0.0.1" });
      listenPort = app.server.address().port;
    }
    return listenPort;
  }

  async function signIn(email) {
    lastMagicLink = undefined;
    await app.inject({ method: "POST", url: "/api/auth/magic-link", payload: { email } });
    assert.ok(lastMagicLink, `magic link issued for ${email}`);
    const verify = await app.inject({
      method: "GET",
      url: lastMagicLink.slice(BASE_URL.length),
    });
    const cookie = sessionCookieFromResponse(verify);
    assert.ok(cookie, `session cookie set for ${email}`);
    return cookie;
  }

  // Creates a vault for the signed-in user (required before a run can be created).
  async function createVault(cookie) {
    const res = await app.inject({
      method: "POST",
      url: "/api/vault",
      headers: { cookie },
      payload: {
        publicKey: Buffer.from("recipient-public-key-32-bytes!!!").toString("base64"),
        wrappedPrivateKey: Buffer.from("wpk").toString("base64"),
        kdfSalt: Buffer.from("salt").toString("base64"),
        kdfParams: {},
      },
    });
    assert.equal(res.statusCode, 204);
  }

  // Creates a client-custody member and returns its id.
  async function createMember(cookie, name = "Alice") {
    const res = await app.inject({
      method: "POST",
      url: "/api/members",
      headers: { cookie },
      payload: {
        displayName: name,
        custody: "client",
        encryptedSecret: Buffer.from(`sealed-${name}`).toString("base64"),
      },
    });
    assert.equal(res.statusCode, 201);
    return res.json().id;
  }

  const validApplicant = {
    identityDocument: { type: "passport", number: "P-SECRET-12345" },
    dateOfBirth: "1990-05-20",
  };

  function createRunPayload(memberId, overrides = {}) {
    return {
      memberId,
      applicant: validApplicant,
      purpose: "right_to_work",
      twoFactorMethod: "sms",
      ...overrides,
    };
  }

  before(async () => {
    bootstrap = new Pool({ connectionString: DATABASE_URL });
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

    engine = createStubEngine();

    const mailer = {
      async sendMagicLink(_to, link) {
        lastMagicLink = link;
      },
    };
    const env = {
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      PUBLIC_BASE_URL: BASE_URL,
      SESSION_TTL_MINUTES: 60,
      MAGIC_LINK_TTL_MINUTES: 15,
      EVISA_HEADLESS: true,
      EVISA_DIAGNOSTICS_MODE: "sanitized_on_failure",
    };

    // A real Postgres artifact store would need its own ttl; we use the same one
    // the app uses so listing/streaming exercise the real code path.
    const { createPostgresArtifactStore } = await import(
      "../dist/runner/artifact-store.js"
    );
    const artifactStore = createPostgresArtifactStore(db, { ttlMs: 3_600_000 });

    app = createWebServer({
      db,
      engine,
      env,
      log,
      mailer,
      entitlements: {
        async canCreateRun() {
          return canCreateRun;
        },
        async maxMembers() {
          return 6;
        },
      },
      artifactStore,
      getHealth: () => ({ ready: true, shuttingDown: false, startedAt: "" }),
    });
    await app.ready();
  });

  after(async () => {
    if (app) await app.close().catch(() => {});
    if (pool) await pool.end().catch(() => {});
    if (bootstrap) {
      await bootstrap
        .query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`)
        .catch(() => {});
      await bootstrap.end().catch(() => {});
    }
  });

  beforeEach(async () => {
    canCreateRun = true;
    engine.setAcceptNext(true);
    engine.enqueued.length = 0;
    engine.submitCalls.length = 0;
    engine.cancelCalls.length = 0;
    lastMagicLink = undefined;
    await pool.query(
      "TRUNCATE run_artifacts, run_events, runs, family_members, magic_link_tokens, sessions, user_vault, users RESTART IDENTITY CASCADE"
    );
  });

  // --- Auth gate ---------------------------------------------------------------

  it("requires authentication for every run route", async () => {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/runs",
          payload: createRunPayload("11111111-1111-1111-1111-111111111111"),
        })
      ).statusCode,
      401
    );
    assert.equal((await app.inject({ method: "GET", url: "/api/runs" })).statusCode, 401);
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/runs/abc/events" })).statusCode,
      401
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/runs/abc/code",
          payload: { code: "123" },
        })
      ).statusCode,
      401
    );
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/runs/abc/cancel" })).statusCode,
      401
    );
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/runs/abc/artifacts" })).statusCode,
      401
    );
  });

  // --- POST /api/runs ----------------------------------------------------------

  it("creates a run: enqueues client custody with the inline applicant + vault key, persists only a pending row", async () => {
    const cookie = await signIn("creator@example.com");
    await createVault(cookie);
    const memberId = await createMember(cookie, "Alice");

    const res = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { cookie },
      payload: createRunPayload(memberId),
    });
    assert.equal(res.statusCode, 201);
    const { runId } = res.json();
    assert.ok(runId);

    // The engine received exactly one enqueue with client custody, the inline
    // applicant verbatim, the vault public key as the recipient, and a user: ownerKey.
    assert.equal(engine.enqueued.length, 1);
    const input = engine.enqueued[0];
    assert.equal(input.runId, runId);
    assert.equal(input.custody, "client");
    assert.match(input.ownerKey, /^user:/);
    assert.equal(input.trigger, "manual");
    assert.equal(input.headless, true);
    assert.equal(input.applicant.kind, "inline");
    assert.deepEqual(input.applicant.applicant, validApplicant);
    assert.equal(input.applicant.purpose, "right_to_work");
    assert.equal(input.applicant.twoFactorMethod, "sms");
    assert.equal(input.applicant.memberName, "Alice");
    // Recipient key equals the vault public key bytes.
    assert.equal(
      Buffer.from(input.recipientPublicKey).toString("base64"),
      Buffer.from("recipient-public-key-32-bytes!!!").toString("base64")
    );

    // The DB row exists, is pending, and holds NO applicant/secret data.
    const { rows } = await pool.query(
      "SELECT id, status, family_member_id, encrypted_share_code FROM runs WHERE id = $1",
      [runId]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pending");
    assert.equal(rows[0].family_member_id, memberId);
    assert.equal(rows[0].encrypted_share_code, null);

    // The plaintext doc number never landed anywhere in the runs/run_events tables.
    const leak = await pool.query(
      "SELECT count(*)::int AS n FROM runs WHERE encrypted_share_code LIKE '%P-SECRET%'"
    );
    assert.equal(leak.rows[0].n, 0);
  });

  it("rejects a malformed run body with 400 (and does not enqueue)", async () => {
    const cookie = await signIn("badbody@example.com");
    await createVault(cookie);
    const memberId = await createMember(cookie);

    // Missing applicant.
    const r1 = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { cookie },
      payload: { memberId, purpose: "right_to_work" },
    });
    assert.equal(r1.statusCode, 400);
    // Invalid purpose.
    const r2 = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { cookie },
      payload: createRunPayload(memberId, { purpose: "nope" }),
    });
    assert.equal(r2.statusCode, 400);
    assert.equal(engine.enqueued.length, 0);
  });

  it("returns 404 when the member does not belong to the caller, 409 when no vault exists", async () => {
    const cookie = await signIn("novaultmember@example.com");

    // No vault yet, and a random member id → member ownership fails first → 404.
    const r404 = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { cookie },
      payload: createRunPayload("22222222-2222-2222-2222-222222222222"),
    });
    assert.equal(r404.statusCode, 404);

    // A real member but still no vault → 409 no_vault.
    const memberId = await createMember(cookie);
    const r409 = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { cookie },
      payload: createRunPayload(memberId),
    });
    assert.equal(r409.statusCode, 409);
    assert.equal(r409.json().error, "no_vault");
    assert.equal(engine.enqueued.length, 0);
  });

  it("honors the entitlement gate (403 run_not_allowed)", async () => {
    const cookie = await signIn("gated@example.com");
    await createVault(cookie);
    const memberId = await createMember(cookie);
    canCreateRun = false;

    const res = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { cookie },
      payload: createRunPayload(memberId),
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, "run_not_allowed");
    assert.equal(engine.enqueued.length, 0);
  });

  it("returns 409 when a run is already active for the member (partial unique index)", async () => {
    const cookie = await signIn("dup@example.com");
    await createVault(cookie);
    const memberId = await createMember(cookie);

    const first = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { cookie },
      payload: createRunPayload(memberId),
    });
    assert.equal(first.statusCode, 201);
    // Second insert for the same member while the first is still pending → unique
    // violation → 409.
    const second = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { cookie },
      payload: createRunPayload(memberId),
    });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().error, "run_already_active");
  });

  // --- code / cancel -----------------------------------------------------------

  it("POST /api/runs/:id/code forwards to the engine (202) and 409 when no pending gate", async () => {
    const cookie = await signIn("code@example.com");
    await createVault(cookie);
    const memberId = await createMember(cookie);
    const runId = (
      await app.inject({
        method: "POST",
        url: "/api/runs",
        headers: { cookie },
        payload: createRunPayload(memberId),
      })
    ).json().runId;

    // Engine accepts the code → 202.
    engine.setSubmitResult(runId, true);
    const ok = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/code`,
      headers: { cookie },
      payload: { code: "424242" },
    });
    assert.equal(ok.statusCode, 202);
    assert.deepEqual(engine.submitCalls.at(-1), { runId, code: "424242" });

    // Engine has no pending gate → 409.
    engine.setSubmitResult(runId, false);
    const conflict = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/code`,
      headers: { cookie },
      payload: { code: "000000" },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error, "no_pending_challenge");

    // Malformed code body → 400, no engine call.
    const before = engine.submitCalls.length;
    const bad = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/code`,
      headers: { cookie },
      payload: {},
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(engine.submitCalls.length, before);
  });

  it("POST /api/runs/:id/cancel forwards to the engine (202) and 409 when not cancellable", async () => {
    const cookie = await signIn("cancel@example.com");
    await createVault(cookie);
    const memberId = await createMember(cookie);
    const runId = (
      await app.inject({
        method: "POST",
        url: "/api/runs",
        headers: { cookie },
        payload: createRunPayload(memberId),
      })
    ).json().runId;

    engine.setCancelResult(runId, true);
    const ok = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/cancel`,
      headers: { cookie },
    });
    assert.equal(ok.statusCode, 202);
    assert.equal(engine.cancelCalls.at(-1).runId, runId);

    engine.setCancelResult(runId, false);
    const conflict = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/cancel`,
      headers: { cookie },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error, "not_cancellable");
  });

  // --- history -----------------------------------------------------------------

  it("GET /api/runs returns the caller's history with status fields only (no secrets)", async () => {
    const cookie = await signIn("history@example.com");
    await createVault(cookie);
    const m1 = await createMember(cookie, "M1");
    const m2 = await createMember(cookie, "M2");

    const r1 = (
      await app.inject({
        method: "POST",
        url: "/api/runs",
        headers: { cookie },
        payload: createRunPayload(m1),
      })
    ).json().runId;
    await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { cookie },
      payload: createRunPayload(m2),
    });

    // Mark r1 as success WITH a (fake) sealed share code to prove it is NOT
    // returned by the history endpoint.
    await pool.query(
      "UPDATE runs SET status='success', encrypted_share_code='SEALED', share_code_alg='box_seal', custody='client', valid_until=now() WHERE id=$1",
      [r1]
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/runs",
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    const { runs } = res.json();
    assert.equal(runs.length, 2);
    // No secret-bearing fields anywhere in the payload.
    const serialized = JSON.stringify(runs);
    assert.ok(
      !serialized.includes("SEALED"),
      "history must not leak the sealed share code"
    );
    assert.ok(!serialized.includes("P-SECRET"), "history must not leak applicant data");
    // The shape is the secret-free history item.
    const keys = Object.keys(runs[0]).sort();
    assert.deepEqual(keys, [
      "createdAt",
      "custody",
      "errorCode",
      "familyMemberId",
      "id",
      "status",
      "trigger",
      "validUntil",
    ]);
  });

  // --- artifacts ---------------------------------------------------------------

  it("lists and streams sealed artifacts as opaque octet-stream bytes", async () => {
    const cookie = await signIn("artifacts@example.com");
    await createVault(cookie);
    const memberId = await createMember(cookie);
    const runId = (
      await app.inject({
        method: "POST",
        url: "/api/runs",
        headers: { cookie },
        payload: createRunPayload(memberId),
      })
    ).json().runId;

    // Insert a sealed artifact row directly (the engine would do this; here we
    // exercise the read path). Bytes are opaque sealed bytes.
    const sealedBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
    const { rows } = await pool.query(
      `INSERT INTO run_artifacts (run_id, kind, filename, sealed_alg, storage, bytes, byte_length, expires_at)
       VALUES ($1,'evisa_pdf','evisa.pdf','box_seal','db',$2,$3, now() + interval '1 hour')
       RETURNING id`,
      [runId, sealedBytes, sealedBytes.byteLength]
    );
    const artifactId = rows[0].id;

    // Listing: metadata only, no bytes.
    const list = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/artifacts`,
      headers: { cookie },
    });
    assert.equal(list.statusCode, 200);
    const { artifacts } = list.json();
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].id, artifactId);
    assert.equal(artifacts[0].kind, "evisa_pdf");
    assert.equal(artifacts[0].sealedAlg, "box_seal");
    assert.equal(artifacts[0].byteLength, sealedBytes.byteLength);
    assert.ok(!("bytes" in artifacts[0]), "listing must not include bytes");

    // Streaming: exact sealed bytes, octet-stream, no-store.
    const blob = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/artifacts/${artifactId}`,
      headers: { cookie },
    });
    assert.equal(blob.statusCode, 200);
    assert.equal(blob.headers["content-type"], "application/octet-stream");
    assert.equal(blob.headers["cache-control"], "no-store");
    assert.ok(
      Buffer.from(blob.rawPayload).equals(sealedBytes),
      "sealed bytes returned verbatim"
    );

    // Unknown artifact id → 404.
    const missing = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/artifacts/33333333-3333-3333-3333-333333333333`,
      headers: { cookie },
    });
    assert.equal(missing.statusCode, 404);
  });

  // --- cross-user authorization ------------------------------------------------

  it("user B cannot read, code, cancel, or fetch artifacts of user A's run", async () => {
    const cookieA = await signIn("ownerA@example.com");
    await createVault(cookieA);
    const memberA = await createMember(cookieA, "A-member");
    const runId = (
      await app.inject({
        method: "POST",
        url: "/api/runs",
        headers: { cookie: cookieA },
        payload: createRunPayload(memberA),
      })
    ).json().runId;
    // A sealed artifact on A's run.
    await pool.query(
      `INSERT INTO run_artifacts (run_id, kind, sealed_alg, storage, bytes, byte_length, expires_at)
       VALUES ($1,'evisa_pdf','box_seal','db',$2,2, now() + interval '1 hour')`,
      [runId, Buffer.from([1, 2])]
    );

    const cookieB = await signIn("intruderB@example.com");

    // Every per-run route returns 404 for B (indistinguishable from missing).
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/runs/${runId}/events`,
          headers: { cookie: cookieB },
        })
      ).statusCode,
      404
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/runs/${runId}/code`,
          headers: { cookie: cookieB },
          payload: { code: "123456" },
        })
      ).statusCode,
      404
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/runs/${runId}/cancel`,
          headers: { cookie: cookieB },
        })
      ).statusCode,
      404
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/runs/${runId}/artifacts`,
          headers: { cookie: cookieB },
        })
      ).statusCode,
      404
    );

    // B never reached the engine for code/cancel (the ownership gate ran first).
    assert.equal(engine.submitCalls.length, 0);
    assert.equal(engine.cancelCalls.length, 0);

    // B's own history does not include A's run.
    const bHistory = await app.inject({
      method: "GET",
      url: "/api/runs",
      headers: { cookie: cookieB },
    });
    assert.deepEqual(bHistory.json().runs, []);
  });

  // --- SSE over a real HTTP listener ------------------------------------------

  it("streams SSE frames queued→started→phase→challenge_required→(code)→completed then closes", async () => {
    const cookie = await signIn("sse@example.com");
    await createVault(cookie);
    const memberId = await createMember(cookie, "SSE");
    const runId = (
      await app.inject({
        method: "POST",
        url: "/api/runs",
        headers: { cookie },
        payload: createRunPayload(memberId),
      })
    ).json().runId;

    // Start a real listener so we can use a true HTTP client for the stream.
    const port = await ensureListening();

    // Drive the bus on a timeline: queued/started/phase, then challenge, and only
    // after the client submits the code do we publish completed (which ends stream).
    engine.setSubmitResult(runId, true);

    const frames = [];
    const done = new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: `/api/runs/${runId}/events`,
          method: "GET",
          headers: { cookie, accept: "text/event-stream" },
        },
        (res) => {
          assert.equal(res.statusCode, 200);
          assert.match(res.headers["content-type"], /text\/event-stream/);
          let buffer = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            buffer += chunk;
            const drained = drainSseRecords(buffer);
            buffer = drained.rest;
            for (const { event: evt } of drained.records) {
              frames.push(evt);
              // When we see the 2FA challenge, submit the code via the HTTP API,
              // which (in the real engine) resolves the gate; here we then publish
              // `completed` to advance + terminate the stream.
              if (evt.type === "challenge_required") {
                app
                  .inject({
                    method: "POST",
                    url: `/api/runs/${runId}/code`,
                    headers: { cookie },
                    payload: { code: "999111" },
                  })
                  .then(() => {
                    engine.emit(runId, {
                      type: "completed",
                      validUntil: "2031-01-01",
                      sealedShareCode: { alg: "box_seal", bytes: new Uint8Array([9]) },
                    });
                  })
                  .catch(reject);
              }
            }
          });
          res.on("end", resolve);
          res.on("error", reject);
        }
      );
      req.on("error", reject);
      req.end();
    });

    // Give the subscriber a tick to attach, then publish the pre-challenge events.
    await new Promise((r) => setTimeout(r, 50));
    engine.emit(runId, { type: "queued", position: 1, active: 1 });
    engine.emit(runId, { type: "started" });
    engine.emit(runId, { type: "phase", phase: "launching", label: "Launching browser" });
    engine.emit(runId, { type: "challenge_required", method: "sms", deadlineMs: 60_000 });

    // The stream ends when `completed` flushes the subscriber (terminal event).
    await done;

    const types = frames.map((f) => f.type);
    assert.deepEqual(types, [
      "queued",
      "started",
      "phase",
      "challenge_required",
      "completed",
    ]);
    // The code submission reached the engine for this run.
    assert.deepEqual(engine.submitCalls.at(-1), { runId, code: "999111" });
    // Completed payload arrived with the sealed (never plaintext) share code.
    const completed = frames.at(-1);
    assert.equal(completed.validUntil, "2031-01-01");
    assert.equal(completed.sealedShareCode.alg, "box_seal");
    assert.ok(
      !("shareCode" in completed),
      "client-custody completed carries no plaintext"
    );
  });

  it("SSE resumes via Last-Event-ID, skipping already-seen backlog frames", async () => {
    const cookie = await signIn("resume@example.com");
    await createVault(cookie);
    const memberId = await createMember(cookie, "Resume");
    const runId = (
      await app.inject({
        method: "POST",
        url: "/api/runs",
        headers: { cookie },
        payload: createRunPayload(memberId),
      })
    ).json().runId;

    const port = await ensureListening();

    // Pre-publish a backlog of three non-terminal events the "first connection"
    // would have seen (ids 0,1,2).
    engine.emit(runId, { type: "queued", position: 1, active: 1 });
    engine.emit(runId, { type: "started" });
    engine.emit(runId, { type: "phase", phase: "launching", label: "Launching browser" });

    // Reconnect claiming we already saw through id 1 → only id>=2 should arrive,
    // plus a later live `completed`.
    const frames = [];
    const ids = [];
    const done = new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: `/api/runs/${runId}/events`,
          method: "GET",
          headers: { cookie, accept: "text/event-stream", "last-event-id": "1" },
        },
        (res) => {
          let buffer = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            buffer += chunk;
            const drained = drainSseRecords(buffer);
            buffer = drained.rest;
            for (const { id, event } of drained.records) {
              if (id !== undefined) ids.push(id);
              frames.push(event);
            }
          });
          res.on("end", resolve);
          res.on("error", reject);
        }
      );
      req.on("error", reject);
      req.end();
    });

    // Let the (terminal-grace) replay attach, then publish a live terminal event.
    await new Promise((r) => setTimeout(r, 50));
    engine.emit(runId, {
      type: "completed",
      validUntil: "2031-02-02",
      sealedShareCode: { alg: "box_seal", bytes: new Uint8Array([1]) },
    });
    await done;

    // We skipped backlog ids 0 and 1; received id 2 (phase) and id 3 (completed).
    assert.deepEqual(ids, [2, 3]);
    assert.deepEqual(
      frames.map((f) => f.type),
      ["phase", "completed"]
    );
  });
});
