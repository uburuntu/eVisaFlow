import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import pino from "pino";
import {
  bytesToString,
  fromBase64,
  generateBoxKeypair,
  openSealed,
  ready,
  unpackArtifactEnvelope,
} from "../dist/crypto/seal.js";
import { insertRun } from "../dist/db/runs.js";
import { schema } from "../dist/db/schema.js";
import { upsertUser } from "../dist/db/users.js";
import { createPostgresArtifactStore } from "../dist/runner/artifact-store.js";
import { resetQueueForTests, setConcurrency } from "../dist/runner/queue.js";
import { createInMemoryRunBus } from "../dist/runner/run-bus.js";
import { createRunEngine } from "../dist/runner/run-engine.js";
import { resetPendingForTests } from "../dist/runner/two-factor-store.js";

// End-to-end client-custody (E2EE) test against a live Postgres. SKIPPED unless
// DATABASE_URL is set and reachable, matching db.test.js / artifact-store.test.js.
//
// SAFETY: point DATABASE_URL only at a local/ephemeral Postgres. This creates an
// isolated throwaway schema and drops it afterwards; it never touches the
// `public` schema or any production data.
//
// The E2EE invariant under test: for a client-custody run the worker holds
// plaintext only transiently in RAM; it seals every output to the recipient's
// PUBLIC key and persists/transmits ONLY sealed forms. No plaintext document
// number, DOB, or share code may ever reach the DB, the event timeline, or a log.

const DATABASE_URL = process.env.DATABASE_URL;
const TEST_SCHEMA = `evisaflow_clientcustody_${process.pid}_${Date.now().toString(36)}`;

// Distinctive plaintext secrets so the hard negative test can grep for them
// unambiguously across persisted rows and captured log lines.
const SECRET_DOC_NUMBER = "SECRETDOCNUM12345";
const SECRET_DOB = "1987-06-05";
const SECRET_SHARE_CODE = "SECRETSHARECODE99";
// The member's identity, as it appears in a REAL artifact filename
// (`EVISA_{Surname}_{GivenName}_{expiry}.pdf`). This is plaintext-at-rest PII
// that must never reach `run_artifacts.filename`; it is sealed inside the
// artifact envelope instead. Used to guard against the filename-leak regression.
const SECRET_SURNAME = "SECRETSURNAMEXYZ";
const SECRET_GIVEN_NAME = "SECRETGIVENNAMEQ";
const SECRET_PDF_FILENAME = `EVISA_${SECRET_SURNAME}_${SECRET_GIVEN_NAME}_2031-03-03.pdf`;
const SECRET_HTML_FILENAME = `EVISA_STATUS_${SECRET_SURNAME}_${SECRET_GIVEN_NAME}.html`;

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

async function ensurePgcrypto(client) {
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
  } catch (err) {
    const code = err?.code;
    if (code !== "23505" && code !== "42710") throw err;
  }
}

/**
 * A capturing logger: a real pino instance with NO redaction, writing every
 * serialized line into `lines`. Deliberately unredacted so the hard negative
 * test catches a plaintext leak under ANY key (the production logger's redaction
 * would otherwise mask exactly the kind of bug we want to surface). Child loggers
 * (the engine creates `log.child({ runId, custody })`) inherit the same stream.
 */
function makeCaptureLogger() {
  const lines = [];
  const stream = {
    write(line) {
      lines.push(line);
    },
  };
  const logger = pino({ level: "trace" }, stream);
  return { logger, lines };
}

async function collect(iterable, predicate) {
  const events = [];
  for await (const event of iterable) {
    events.push(event);
    if (predicate?.(event, events)) break;
  }
  return events;
}

/**
 * Polls the `runs` row until it reaches a terminal status (or times out). The
 * DB-persistence subscriber writes asynchronously and best-effort, so the row is
 * not guaranteed updated the instant the live event stream ends; polling avoids a
 * flaky fixed-tick wait.
 */
async function waitForRunStatus(pool, runId, statuses, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = (await pool.query("SELECT status FROM runs WHERE id = $1", [runId]))
      .rows[0];
    if (row && statuses.includes(row.status)) return row.status;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(
    `run ${runId} did not reach ${statuses.join("/")} within ${timeoutMs}ms`
  );
}

const skip = await probeDatabase();

describe("RunEngine client custody (E2EE) — sealed outputs + persistence", {
  skip: skip ?? false,
}, () => {
  let bootstrap;
  let pool;
  let db;
  let store;

  before(async () => {
    await ready(); // initialize libsodium WASM before any sealing/opening
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

  let nextTelegramId = 7000;
  beforeEach(async () => {
    resetQueueForTests();
    resetPendingForTests();
    setConcurrency(2);
    await pool.query(
      "TRUNCATE run_artifacts, run_events, runs, family_members, users RESTART IDENTITY CASCADE"
    );
  });

  // A client-custody member: the server stores ONLY a sealed `encrypted_secret`
  // blob; the cleartext-ish columns stay NULL. The run itself supplies the
  // inline plaintext applicant (decrypted in the browser), so the member row
  // here only anchors the FK chain and proves no plaintext is stored for it.
  // Inserted via raw SQL because `addFamilyMember` is the server-custody helper
  // (a client-member insert API lands in Phase 4).
  async function makeClientRun() {
    nextTelegramId += 1;
    const user = await upsertUser(db, nextTelegramId, "Web User", null, 30);
    const memberRow = (
      await pool.query(
        `INSERT INTO family_members (user_id, display_name, custody, encrypted_secret)
         VALUES ($1, 'Private Member', 'client', $2) RETURNING id`,
        [user.id, Buffer.from([9, 8, 7, 6, 5])]
      )
    ).rows[0];
    const run = await insertRun(db, {
      user_id: user.id,
      family_member_id: memberRow.id,
      trigger: "manual",
    });
    return { user, member: memberRow, run };
  }

  /** The fake result a client-custody run "produces", carrying the secrets. */
  function fakeResult() {
    return {
      shareCode: SECRET_SHARE_CODE,
      validUntil: "2031-03-03",
      pdf: {
        kind: "bytes",
        bytes: new TextEncoder().encode(`EVISA-PDF::${SECRET_SHARE_CODE}`),
        // Identity-bearing filename, like a real run produces.
        filename: SECRET_PDF_FILENAME,
        contentType: "application/pdf",
        byteLength: 0,
      },
      checker: {
        shareCode: SECRET_SHARE_CODE,
        html: {
          kind: "bytes",
          bytes: new TextEncoder().encode(`CHECKER-HTML::${SECRET_DOC_NUMBER}`),
          filename: SECRET_HTML_FILENAME,
          contentType: "text/html",
          byteLength: 0,
          standalone: true,
        },
      },
    };
  }

  function clientInput(run, recipientPublicKey) {
    return {
      runId: run.id,
      ownerKey: `owner-${run.id}`,
      custody: "client",
      recipientPublicKey,
      trigger: "manual",
      headless: true,
      diagnosticsMode: "off",
      applicant: {
        kind: "inline",
        applicant: {
          identityDocument: { type: "passport", number: SECRET_DOC_NUMBER },
          dateOfBirth: SECRET_DOB,
        },
        purpose: "right_to_work",
        twoFactorMethod: "sms",
        memberName: "Private Member",
      },
    };
  }

  it("seals share code + artifacts to the recipient key; persists ONLY sealed forms; the client can open them", async () => {
    const recipient = generateBoxKeypair();
    const { run } = await makeClientRun();
    const { logger, lines } = makeCaptureLogger();

    const bus = createInMemoryRunBus();
    const engine = createRunEngine({
      bus,
      db,
      artifactStore: store,
      logger,
      // No serverKeyHex: a pure client-custody engine never needs the server key.
      runJob: async () => fakeResult(),
    });

    const accepted = engine.enqueueRun(clientInput(run, recipient.publicKey));
    assert.equal(accepted.accepted, true);
    const events = await collect(engine.subscribe(run.id));

    // ---- The completed event carries ONLY the sealed share code ----
    const completed = events.find((e) => e.type === "completed");
    assert.ok(completed, "a completed event is published");
    assert.equal(completed.shareCode, undefined, "NO plaintext share code on completed");
    assert.equal(completed.sealedShareCode.alg, "box_seal");
    assert.ok(completed.sealedShareCode.bytes instanceof Uint8Array);
    assert.equal(completed.sealedShareCode.cipher, undefined);
    // The client opens the sealed share code with its private key.
    const openedCode = bytesToString(
      openSealed(
        completed.sealedShareCode.bytes,
        recipient.publicKey,
        recipient.privateKey
      )
    );
    assert.equal(openedCode, SECRET_SHARE_CODE);

    // ---- Every artifact_ready blob is box_seal and opens to the original ----
    const artifacts = events.filter((e) => e.type === "artifact_ready");
    assert.deepEqual(
      artifacts.map((a) => a.artifact.kind),
      ["pdf", "checker_html"]
    );
    // The live event carries the true (identity-bearing) filename to the client
    // over TLS — that is fine; it is the AT-REST copy that must be name-free.
    assert.equal(artifacts[0].artifact.filename, SECRET_PDF_FILENAME);
    for (const ev of artifacts) {
      const blob = ev.artifact.sealed;
      assert.equal(blob.alg, "box_seal", "artifact sealed with box_seal");
      assert.ok(blob.bytes instanceof Uint8Array);
      // The sealed bytes leak neither the payload (share code / doc number) nor
      // the identity-bearing filename sealed inside the envelope.
      const asText = new TextDecoder().decode(blob.bytes);
      assert.ok(!asText.includes(SECRET_SHARE_CODE));
      assert.ok(!asText.includes(SECRET_DOC_NUMBER));
      assert.ok(!asText.includes(SECRET_SURNAME));
      // The client opens each artifact with its private key.
      openSealed(blob.bytes, recipient.publicKey, recipient.privateKey);
    }
    // Opening the PDF blob yields the envelope: the true filename + raw bytes.
    const openedPdfEnvelope = unpackArtifactEnvelope(
      openSealed(
        artifacts[0].artifact.sealed.bytes,
        recipient.publicKey,
        recipient.privateKey
      )
    );
    assert.equal(openedPdfEnvelope.filename, SECRET_PDF_FILENAME);
    assert.equal(
      new TextDecoder().decode(openedPdfEnvelope.bytes),
      `EVISA-PDF::${SECRET_SHARE_CODE}`
    );

    // Wait for the internal (async, best-effort) DB-persistence subscriber to
    // record the terminal status before asserting the persisted form.
    await waitForRunStatus(pool, run.id, ["success"]);

    // ---- runs row: sealed share code, box_seal alg, client custody ----
    const runRow = (
      await pool.query(
        "SELECT status, encrypted_share_code, share_code_alg, custody, valid_until FROM runs WHERE id = $1",
        [run.id]
      )
    ).rows[0];
    assert.equal(runRow.status, "success");
    assert.equal(runRow.share_code_alg, "box_seal");
    assert.equal(runRow.custody, "client");
    assert.ok(runRow.encrypted_share_code, "encrypted_share_code is stored");
    assert.ok(
      !runRow.encrypted_share_code.includes(SECRET_SHARE_CODE),
      "stored share code is sealed, not plaintext"
    );
    // It is the base64 of the sealed bytes, and opens back to the share code.
    const openedFromDb = bytesToString(
      openSealed(
        fromBase64(runRow.encrypted_share_code),
        recipient.publicKey,
        recipient.privateKey
      )
    );
    assert.equal(openedFromDb, SECRET_SHARE_CODE);

    // ---- run_artifacts: sealed bytes only, box_seal, NEUTRAL filename ----
    const stored = await store.listForRun(run.id);
    assert.equal(stored.length, 2, "both byte artifacts persisted");
    assert.deepEqual(
      stored.map((a) => a.kind),
      ["evisa_pdf", "checker_html"]
    );
    // The AT-REST filename is a neutral, kind-derived placeholder — never the
    // identity-bearing one (that lives sealed inside the envelope).
    assert.deepEqual(
      stored.map((a) => a.filename),
      ["evisa.pdf", "checker.html"],
      "stored filenames are neutral placeholders, not the real (identity) names"
    );
    for (const a of stored) {
      assert.equal(a.sealedAlg, "box_seal");
      assert.ok(Buffer.isBuffer(a.bytes));
      // Opening the stored blob yields the envelope; the real filename + payload
      // are recoverable by the client even for a later async fetch.
      const envelope = unpackArtifactEnvelope(
        openSealed(new Uint8Array(a.bytes), recipient.publicKey, recipient.privateKey)
      );
      assert.ok(
        envelope.filename === SECRET_PDF_FILENAME ||
          envelope.filename === SECRET_HTML_FILENAME,
        "the real filename is recoverable from the sealed envelope"
      );
      const opened = new TextDecoder().decode(envelope.bytes);
      assert.ok(opened.startsWith("EVISA-PDF::") || opened.startsWith("CHECKER-HTML::"));
    }

    // ---- HARD NEGATIVE TEST: no plaintext anywhere persisted or logged ----
    // Includes the identity strings that appear in REAL artifact filenames: a
    // client-custody run must not write the surname/given-name (nor the doc#,
    // DOB, or share code) into ANY column at rest — the filename is sealed inside
    // the artifact envelope, and `run_artifacts.filename` holds only a neutral
    // placeholder. This guards against the filename-leak regression.
    const secrets = [
      SECRET_SHARE_CODE,
      SECRET_DOC_NUMBER,
      SECRET_DOB,
      SECRET_SURNAME,
      SECRET_GIVEN_NAME,
    ];

    // Every run_artifacts row (kind/filename/sealed bytes/...). The bytes are
    // sealed and the filename is a neutral placeholder, so no secret appears.
    const artifactsDump = JSON.stringify(
      (await pool.query("SELECT * FROM run_artifacts")).rows
    );
    for (const secret of secrets) {
      assert.ok(
        !artifactsDump.includes(secret),
        `run_artifacts table must not contain plaintext: ${secret}`
      );
    }

    // Every runs column (as text) — scan the whole row, not just the share code.
    const runsDump = JSON.stringify((await pool.query("SELECT * FROM runs")).rows);
    for (const secret of secrets) {
      assert.ok(
        !runsDump.includes(secret),
        `runs table must not contain plaintext: ${secret}`
      );
    }

    // Every run_events row (event_type/phase/message/metadata/...).
    const eventsDump = JSON.stringify(
      (await pool.query("SELECT * FROM run_events")).rows
    );
    for (const secret of secrets) {
      assert.ok(
        !eventsDump.includes(secret),
        `run_events table must not contain plaintext: ${secret}`
      );
    }

    // Every family_members row (proves the client member stored no cleartext).
    const membersDump = JSON.stringify(
      (await pool.query("SELECT * FROM family_members")).rows
    );
    for (const secret of secrets) {
      assert.ok(
        !membersDump.includes(secret),
        `family_members table must not contain plaintext: ${secret}`
      );
    }

    // Every captured log line (engine + its child loggers), unredacted.
    assert.ok(lines.length > 0, "the engine produced log output");
    const logDump = lines.join("\n");
    for (const secret of secrets) {
      assert.ok(
        !logDump.includes(secret),
        `no log line may contain plaintext: ${secret}`
      );
    }
  });

  it("a missing recipient public key fails the run and persists no share code", async () => {
    const { run } = await makeClientRun();
    const { logger, lines } = makeCaptureLogger();
    const bus = createInMemoryRunBus();
    const engine = createRunEngine({
      bus,
      db,
      artifactStore: store,
      logger,
      runJob: async () => fakeResult(),
    });

    const input = clientInput(run, undefined);
    input.recipientPublicKey = undefined;
    const accepted = engine.enqueueRun(input);
    assert.equal(accepted.accepted, true);
    const events = await collect(engine.subscribe(run.id));

    const failure = events.find((e) => e.type === "failed");
    assert.ok(failure, "the run fails without a recipient key");
    assert.match(failure.message, /recipientPublicKey/i);
    assert.ok(!events.some((e) => e.type === "completed"));

    await waitForRunStatus(pool, run.id, ["failed"]);

    const runRow = (
      await pool.query("SELECT status, encrypted_share_code FROM runs WHERE id = $1", [
        run.id,
      ])
    ).rows[0];
    assert.equal(runRow.status, "failed");
    assert.equal(runRow.encrypted_share_code, null, "no share code persisted on failure");

    // No plaintext leaked even on the failure path.
    const logDump = lines.join("\n");
    for (const secret of [SECRET_SHARE_CODE, SECRET_DOC_NUMBER, SECRET_DOB]) {
      assert.ok(
        !logDump.includes(secret),
        `failure path must not log plaintext: ${secret}`
      );
    }
  });
});
