import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { schema } from "../dist/db/schema.js";
import { createWebServer } from "../dist/web/server.js";

// End-to-end vault + member route tests via fastify.inject (no network listener).
// DB-backed and SKIPPED unless DATABASE_URL is set and reachable (matching
// web-auth.test.js / db.test.js).
//
// SAFETY: point DATABASE_URL only at a local/ephemeral Postgres. This creates an
// isolated throwaway schema and drops it afterwards; it never touches the
// `public` schema or any production data.

const DATABASE_URL = process.env.DATABASE_URL;
const TEST_SCHEMA = `evisaflow_vaultmembers_${process.pid}_${Date.now().toString(36)}`;
const BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"; // sample, not real
const BASE_URL = "https://app.test";

// Schema slice these routes touch: users + vault + sessions + magic-link (for
// sign-in) + family_members with the per-custody CHECK and the max-6 trigger.
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
-- family_members mirrored through migration 005 (custody + sealed secret, nullable
-- cleartext columns, per-custody integrity CHECK) plus the max-6-active trigger.
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

const skip = await probeDatabase();

describe("web vault + member routes (fastify.inject)", { skip: skip ?? false }, () => {
  let bootstrap;
  let pool;
  let db;
  let app;
  let lastMagicLink;
  // Per-test entitlement knob: the server is built once, so it reads this live.
  let maxMembers = 6;

  // Signs in a fresh email user via the real magic-link flow and returns the
  // resulting session cookie. Gives every test an authenticated principal without
  // reaching into session internals.
  async function signIn(email) {
    lastMagicLink = undefined;
    await app.inject({
      method: "POST",
      url: "/api/auth/magic-link",
      payload: { email },
    });
    assert.ok(lastMagicLink, `magic link issued for ${email}`);
    const verify = await app.inject({
      method: "GET",
      url: lastMagicLink.slice(BASE_URL.length),
    });
    const cookie = sessionCookieFromResponse(verify);
    assert.ok(cookie, `session cookie set for ${email}`);
    return cookie;
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
    };
    app = createWebServer({
      db,
      engine: {},
      env,
      log,
      mailer,
      entitlements: {
        async canCreateRun() {
          return true;
        },
        async maxMembers() {
          return maxMembers;
        },
      },
      artifactStore: {},
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
    maxMembers = 6;
    lastMagicLink = undefined;
    await pool.query(
      "TRUNCATE family_members, magic_link_tokens, sessions, user_vault, users RESTART IDENTITY CASCADE"
    );
  });

  // --- Vault -------------------------------------------------------------------

  it("requires authentication for vault routes", async () => {
    const get = await app.inject({ method: "GET", url: "/api/vault" });
    assert.equal(get.statusCode, 401);
    const post = await app.inject({
      method: "POST",
      url: "/api/vault",
      payload: {
        publicKey: "AA==",
        wrappedPrivateKey: "AA==",
        kdfSalt: "AA==",
        kdfParams: {},
      },
    });
    assert.equal(post.statusCode, 401);
  });

  it("POST then GET /api/vault round-trips the opaque blobs byte-for-byte", async () => {
    const cookie = await signIn("vault@example.com");

    // Distinct base64 blobs standing in for the real libsodium outputs.
    const body = {
      publicKey: Buffer.from("public-key-bytes").toString("base64"),
      wrappedPrivateKey: Buffer.from("wrapped-private-key-bytes").toString("base64"),
      kdfSalt: Buffer.from("kdf-salt-bytes").toString("base64"),
      kdfParams: { alg: "argon2id13", opslimit: 3, memlimit: 67108864 },
      recoveryWrappedKey: Buffer.from("recovery-wrapped-key-bytes").toString("base64"),
    };
    const post = await app.inject({
      method: "POST",
      url: "/api/vault",
      headers: { cookie },
      payload: body,
    });
    assert.equal(post.statusCode, 204);

    const get = await app.inject({
      method: "GET",
      url: "/api/vault",
      headers: { cookie },
    });
    assert.equal(get.statusCode, 200);
    const got = get.json();
    assert.equal(got.publicKey, body.publicKey);
    assert.equal(got.wrappedPrivateKey, body.wrappedPrivateKey);
    assert.equal(got.kdfSalt, body.kdfSalt);
    assert.deepEqual(got.kdfParams, body.kdfParams);
    assert.equal(got.recoveryWrappedKey, body.recoveryWrappedKey);

    // The DB stored the SAME bytes (server never transforms them).
    const { rows } = await pool.query("SELECT public_key, kdf_params FROM user_vault");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].public_key.toString("base64"), body.publicKey);
    assert.deepEqual(rows[0].kdf_params, body.kdfParams);
  });

  it("POST /api/vault upserts (re-wrap) and tolerates an omitted recovery key", async () => {
    const cookie = await signIn("rewrap@example.com");

    const first = await app.inject({
      method: "POST",
      url: "/api/vault",
      headers: { cookie },
      payload: {
        publicKey: Buffer.from("pk-1").toString("base64"),
        wrappedPrivateKey: Buffer.from("wpk-1").toString("base64"),
        kdfSalt: Buffer.from("salt-1").toString("base64"),
        kdfParams: { v: 1 },
        recoveryWrappedKey: Buffer.from("rec-1").toString("base64"),
      },
    });
    assert.equal(first.statusCode, 204);

    // Re-wrap WITHOUT a recovery key → blob replaced, recovery cleared to null.
    const second = await app.inject({
      method: "POST",
      url: "/api/vault",
      headers: { cookie },
      payload: {
        publicKey: Buffer.from("pk-2").toString("base64"),
        wrappedPrivateKey: Buffer.from("wpk-2").toString("base64"),
        kdfSalt: Buffer.from("salt-2").toString("base64"),
        kdfParams: { v: 2 },
      },
    });
    assert.equal(second.statusCode, 204);

    const get = await app.inject({
      method: "GET",
      url: "/api/vault",
      headers: { cookie },
    });
    const got = get.json();
    assert.equal(got.publicKey, Buffer.from("pk-2").toString("base64"));
    assert.deepEqual(got.kdfParams, { v: 2 });
    assert.equal(got.recoveryWrappedKey, null, "recovery cleared on re-wrap");

    // Still exactly one vault row for the user (upsert, not insert).
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM user_vault");
    assert.equal(rows[0].n, 1);
  });

  it("GET /api/vault returns 404 before a vault exists; POST rejects a malformed body", async () => {
    const cookie = await signIn("novault@example.com");
    const get = await app.inject({
      method: "GET",
      url: "/api/vault",
      headers: { cookie },
    });
    assert.equal(get.statusCode, 404);

    const bad = await app.inject({
      method: "POST",
      url: "/api/vault",
      headers: { cookie },
      payload: { publicKey: "AA==" }, // missing required fields
    });
    assert.equal(bad.statusCode, 400);
  });

  // --- Members -----------------------------------------------------------------

  it("requires authentication for member routes", async () => {
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/members" })).statusCode,
      401
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/members",
          payload: { displayName: "X", custody: "client", encryptedSecret: "AA==" },
        })
      ).statusCode,
      401
    );
    assert.equal(
      (await app.inject({ method: "DELETE", url: "/api/members/some-id" })).statusCode,
      401
    );
  });

  it("creates, lists, and soft-deletes a client member, storing ONLY the sealed secret", async () => {
    const cookie = await signIn("members@example.com");

    // Empty to start.
    const empty = await app.inject({
      method: "GET",
      url: "/api/members",
      headers: { cookie },
    });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json().members, []);

    const sealed = Buffer.from("sealed-applicant-blob").toString("base64");
    const create = await app.inject({
      method: "POST",
      url: "/api/members",
      headers: { cookie },
      payload: { displayName: "Alice", custody: "client", encryptedSecret: sealed },
    });
    assert.equal(create.statusCode, 201);
    const created = create.json();
    assert.equal(created.displayName, "Alice");
    assert.equal(created.custody, "client");
    assert.equal(created.encryptedSecret, sealed);
    assert.ok(created.id);

    // List returns it with the sealed secret and NO plaintext fields.
    const list = await app.inject({
      method: "GET",
      url: "/api/members",
      headers: { cookie },
    });
    const members = list.json().members;
    assert.equal(members.length, 1);
    assert.deepEqual(Object.keys(members[0]).sort(), [
      "custody",
      "displayName",
      "encryptedSecret",
      "id",
    ]);
    assert.equal(members[0].encryptedSecret, sealed);

    // DB row: client custody, sealed secret present, ALL cleartext-ish columns NULL.
    const { rows } = await pool.query(
      `SELECT custody, encrypted_secret, auth_type, encrypted_doc_number,
              dob_day, dob_month, dob_year, preferred_2fa_method, purpose
         FROM family_members`
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].custody, "client");
    assert.equal(rows[0].encrypted_secret.toString("base64"), sealed);
    assert.equal(rows[0].auth_type, null);
    assert.equal(rows[0].encrypted_doc_number, null);
    assert.equal(rows[0].dob_day, null);
    assert.equal(rows[0].dob_month, null);
    assert.equal(rows[0].dob_year, null);
    assert.equal(rows[0].preferred_2fa_method, null);
    assert.equal(rows[0].purpose, null);

    // Soft-delete → 204, then it disappears from the active list but the row stays
    // (is_active=false), preserving history.
    const del = await app.inject({
      method: "DELETE",
      url: `/api/members/${created.id}`,
      headers: { cookie },
    });
    assert.equal(del.statusCode, 204);
    const after = await app.inject({
      method: "GET",
      url: "/api/members",
      headers: { cookie },
    });
    assert.deepEqual(after.json().members, []);
    const stillThere = await pool.query(
      "SELECT is_active FROM family_members WHERE id = $1",
      [created.id]
    );
    assert.equal(stillThere.rows.length, 1);
    assert.equal(stillThere.rows[0].is_active, false);
  });

  it("rejects a malformed member body and a non-client custody", async () => {
    const cookie = await signIn("badmember@example.com");
    // Missing encryptedSecret.
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/members",
          headers: { cookie },
          payload: { displayName: "X", custody: "client" },
        })
      ).statusCode,
      400
    );
    // custody must be the literal "client".
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/members",
          headers: { cookie },
          payload: { displayName: "X", custody: "server", encryptedSecret: "AA==" },
        })
      ).statusCode,
      400
    );
  });

  it("enforces the entitlement max-members boundary before insert", async () => {
    const cookie = await signIn("limited@example.com");
    maxMembers = 2; // tighten the entitlement for this test

    const add = (name) =>
      app.inject({
        method: "POST",
        url: "/api/members",
        headers: { cookie },
        payload: {
          displayName: name,
          custody: "client",
          encryptedSecret: Buffer.from(`secret-${name}`).toString("base64"),
        },
      });

    assert.equal((await add("One")).statusCode, 201);
    assert.equal((await add("Two")).statusCode, 201);
    // Third exceeds maxMembers=2 → 403, and nothing was inserted.
    const third = await add("Three");
    assert.equal(third.statusCode, 403);
    assert.equal(third.json().error, "member_limit_reached");
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM family_members WHERE is_active = true"
    );
    assert.equal(rows[0].n, 2, "limit rejected before insert");
  });

  // --- Cross-user authorization ------------------------------------------------

  it("isolates vaults and members between users (no cross-user read/delete)", async () => {
    const cookieA = await signIn("alice@example.com");
    const cookieB = await signIn("bob@example.com");

    // A creates a vault and a member.
    await app.inject({
      method: "POST",
      url: "/api/vault",
      headers: { cookie: cookieA },
      payload: {
        publicKey: Buffer.from("A-pk").toString("base64"),
        wrappedPrivateKey: Buffer.from("A-wpk").toString("base64"),
        kdfSalt: Buffer.from("A-salt").toString("base64"),
        kdfParams: { owner: "A" },
      },
    });
    const aMember = (
      await app.inject({
        method: "POST",
        url: "/api/members",
        headers: { cookie: cookieA },
        payload: {
          displayName: "A-member",
          custody: "client",
          encryptedSecret: Buffer.from("A-secret").toString("base64"),
        },
      })
    ).json();

    // B has no vault of their own → 404 (cannot see A's).
    const bVault = await app.inject({
      method: "GET",
      url: "/api/vault",
      headers: { cookie: cookieB },
    });
    assert.equal(bVault.statusCode, 404);

    // B's member list does not include A's member.
    const bList = await app.inject({
      method: "GET",
      url: "/api/members",
      headers: { cookie: cookieB },
    });
    assert.deepEqual(bList.json().members, []);

    // B cannot delete A's member → 404 (indistinguishable from missing).
    const bDelete = await app.inject({
      method: "DELETE",
      url: `/api/members/${aMember.id}`,
      headers: { cookie: cookieB },
    });
    assert.equal(bDelete.statusCode, 404);

    // A's member is untouched and still active.
    const aStill = await pool.query(
      "SELECT is_active FROM family_members WHERE id = $1",
      [aMember.id]
    );
    assert.equal(aStill.rows[0].is_active, true, "B did not delete A's member");

    // B writing their OWN vault does not overwrite A's (1:1 per user).
    await app.inject({
      method: "POST",
      url: "/api/vault",
      headers: { cookie: cookieB },
      payload: {
        publicKey: Buffer.from("B-pk").toString("base64"),
        wrappedPrivateKey: Buffer.from("B-wpk").toString("base64"),
        kdfSalt: Buffer.from("B-salt").toString("base64"),
        kdfParams: { owner: "B" },
      },
    });
    const aVault = await app.inject({
      method: "GET",
      url: "/api/vault",
      headers: { cookie: cookieA },
    });
    assert.deepEqual(aVault.json().kdfParams, { owner: "A" }, "A's vault intact");
    const vaultCount = await pool.query("SELECT count(*)::int AS n FROM user_vault");
    assert.equal(vaultCount.rows[0].n, 2, "two independent vaults");
  });
});
