import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { schema } from "../dist/db/schema.js";
import { createWebServer } from "../dist/web/server.js";

// End-to-end auth route tests via fastify.inject (no network listener). DB-backed
// and SKIPPED unless DATABASE_URL is set and reachable (matching db.test.js).
//
// SAFETY: point DATABASE_URL only at a local/ephemeral Postgres. This creates an
// isolated throwaway schema and drops it afterwards; it never touches the
// `public` schema or any production data.

const DATABASE_URL = process.env.DATABASE_URL;
const TEST_SCHEMA = `evisaflow_webauth_${process.pid}_${Date.now().toString(36)}`;
const BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"; // sample, not real
const BASE_URL = "https://app.test";

// Schema slice the auth routes touch (users + the three web-auth/vault tables).
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

/** Reference Telegram signer (independent of the module under test). */
function signTelegram(fields, botToken) {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secret = createHash("sha256").update(botToken).digest();
  return createHmac("sha256", secret).update(dataCheckString).digest("hex");
}

function freshTelegramPayload(overrides = {}) {
  const fields = {
    id: 555000111,
    first_name: "Grace",
    username: "grace_h",
    auth_date: Math.floor(Date.now() / 1000),
    ...overrides,
  };
  return { ...fields, hash: signTelegram(fields, BOT_TOKEN) };
}

/** Extracts the session cookie value from a response's Set-Cookie header(s). */
function sessionCookieFromResponse(res) {
  const raw = res.headers["set-cookie"];
  const headers = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const h of headers) {
    if (h.startsWith("evisa_session=")) {
      const value = h.slice("evisa_session=".length, h.indexOf(";"));
      return { header: h, value, cookie: `evisa_session=${value}` };
    }
  }
  return null;
}

const skip = await probeDatabase();

describe("web auth routes (fastify.inject)", { skip: skip ?? false }, () => {
  let bootstrap;
  let pool;
  let db;
  let app;
  /** Captures the most recent magic link the mailer was asked to send. */
  let lastMagicLink;

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

    // The Drizzle handle the routes use is built on the SAME search_path-pinned
    // pool, so route DB writes land in the isolated test schema.
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
          return 6;
        },
      },
      artifactStore: {},
      getHealth: () => ({ ready: true, shuttingDown: false, startedAt: "" }),
    });
    await app.ready();
  });

  after(async () => {
    if (app) await app.close().catch(() => {});
    // `db` shares `pool`, so closing the pool below tears down both.
    if (pool) await pool.end().catch(() => {});
    if (bootstrap) {
      await bootstrap
        .query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`)
        .catch(() => {});
      await bootstrap.end().catch(() => {});
    }
  });

  beforeEach(async () => {
    lastMagicLink = undefined;
    await pool.query(
      "TRUNCATE magic_link_tokens, sessions, user_vault, users RESTART IDENTITY CASCADE"
    );
  });

  // --- Magic link --------------------------------------------------------------

  it("POST /api/auth/magic-link always returns 204 (no enumeration), even for junk input", async () => {
    const valid = await app.inject({
      method: "POST",
      url: "/api/auth/magic-link",
      payload: { email: "new@example.com" },
    });
    assert.equal(valid.statusCode, 204);
    assert.ok(lastMagicLink, "a link was dispatched for a well-formed email");

    // Malformed body still 204 and dispatches nothing (no signal about validity).
    lastMagicLink = undefined;
    const junk = await app.inject({
      method: "POST",
      url: "/api/auth/magic-link",
      payload: { email: "not-an-email" },
    });
    assert.equal(junk.statusCode, 204);
    assert.equal(lastMagicLink, undefined, "no link issued for invalid email");

    // Missing body also 204.
    const empty = await app.inject({
      method: "POST",
      url: "/api/auth/magic-link",
      payload: {},
    });
    assert.equal(empty.statusCode, 204);
  });

  it("GET verify consumes the link, sets a session cookie, and redirects to the app", async () => {
    await app.inject({
      method: "POST",
      url: "/api/auth/magic-link",
      payload: { email: "login@example.com" },
    });
    assert.ok(lastMagicLink);
    // The link points at our verify endpoint on the configured base URL.
    assert.ok(lastMagicLink.startsWith(`${BASE_URL}/api/auth/magic-link/verify?token=`));

    const url = lastMagicLink.slice(BASE_URL.length); // path + query
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, `${BASE_URL}/app`);

    const cookie = sessionCookieFromResponse(res);
    assert.ok(cookie, "session cookie set");
    assert.ok(cookie.header.toLowerCase().includes("httponly"));
    assert.ok(cookie.header.toLowerCase().includes("secure"));
    assert.ok(cookie.header.toLowerCase().includes("samesite=lax"));

    // A user row was created (verified) for the email.
    const { rows } = await pool.query("SELECT email, email_verified FROM users");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, "login@example.com");
    assert.equal(rows[0].email_verified, true);

    // The link is single-use: replaying it no longer authenticates.
    const replay = await app.inject({ method: "GET", url });
    assert.equal(replay.statusCode, 302);
    assert.equal(replay.headers.location, `${BASE_URL}/login?error=invalid_link`);
    assert.equal(sessionCookieFromResponse(replay), null, "no cookie on replay");
  });

  it("GET verify with an invalid/blank token redirects to login with a generic error", async () => {
    const bad = await app.inject({
      method: "GET",
      url: "/api/auth/magic-link/verify?token=nope",
    });
    assert.equal(bad.statusCode, 302);
    assert.equal(bad.headers.location, `${BASE_URL}/login?error=invalid_link`);

    const blank = await app.inject({ method: "GET", url: "/api/auth/magic-link/verify" });
    assert.equal(blank.statusCode, 302);
    assert.equal(blank.headers.location, `${BASE_URL}/login?error=invalid_link`);
  });

  // --- me / logout -------------------------------------------------------------

  it("GET /api/auth/me reflects login state and logout clears the session", async () => {
    // Unauthenticated → 401.
    const anon = await app.inject({ method: "GET", url: "/api/auth/me" });
    assert.equal(anon.statusCode, 401);

    // Sign in via magic link.
    await app.inject({
      method: "POST",
      url: "/api/auth/magic-link",
      payload: { email: "me@example.com" },
    });
    const verify = await app.inject({
      method: "GET",
      url: lastMagicLink.slice(BASE_URL.length),
    });
    const cookie = sessionCookieFromResponse(verify);
    assert.ok(cookie);

    // me reflects the signed-in user.
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookie.cookie },
    });
    assert.equal(me.statusCode, 200);
    const body = me.json();
    assert.equal(body.email, "me@example.com");
    assert.equal(body.telegramLinked, false);
    assert.equal(body.hasVault, false);

    // Logout destroys the session and clears the cookie.
    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: cookie.cookie },
    });
    assert.equal(logout.statusCode, 204);
    const cleared = logout.headers["set-cookie"];
    assert.ok(
      (Array.isArray(cleared) ? cleared.join(";") : (cleared ?? "")).includes(
        "evisa_session="
      ),
      "logout clears the cookie"
    );

    // The same cookie no longer authenticates (session row gone).
    const after = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookie.cookie },
    });
    assert.equal(after.statusCode, 401);
  });

  it("logout is idempotent without an active session", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/logout" });
    assert.equal(res.statusCode, 204);
  });

  // --- Telegram login ----------------------------------------------------------

  it("POST /api/auth/telegram with a valid payload signs in (find-or-create) and sets a session", async () => {
    const payload = freshTelegramPayload();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/telegram",
      payload,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.telegramLinked, true);
    assert.equal(body.email, null);
    const cookie = sessionCookieFromResponse(res);
    assert.ok(cookie, "session cookie set on telegram login");

    // The user is persisted with the telegram id.
    const { rows } = await pool.query("SELECT telegram_id FROM users");
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].telegram_id), 555000111);

    // Logging in again with the same id reuses the same user (no duplicate).
    const again = await app.inject({
      method: "POST",
      url: "/api/auth/telegram",
      payload: freshTelegramPayload(),
    });
    assert.equal(again.statusCode, 200);
    const count = await pool.query("SELECT count(*)::int AS n FROM users");
    assert.equal(count.rows[0].n, 1, "no duplicate user for the same telegram id");
  });

  it("POST /api/auth/telegram rejects a tampered payload with 401", async () => {
    const payload = freshTelegramPayload();
    payload.id = 999; // tamper after signing
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/telegram",
      payload,
    });
    assert.equal(res.statusCode, 401);
    const count = await pool.query("SELECT count(*)::int AS n FROM users");
    assert.equal(count.rows[0].n, 0, "no user created on failed verification");
  });

  it("POST /api/auth/telegram links the telegram id to the CURRENT user when a session is present", async () => {
    // Sign in by email first.
    await app.inject({
      method: "POST",
      url: "/api/auth/magic-link",
      payload: { email: "linker@example.com" },
    });
    const verify = await app.inject({
      method: "GET",
      url: lastMagicLink.slice(BASE_URL.length),
    });
    const cookie = sessionCookieFromResponse(verify);
    assert.ok(cookie);

    // Now present a Telegram login WITH that session cookie → link, not new user.
    const link = await app.inject({
      method: "POST",
      url: "/api/auth/telegram",
      headers: { cookie: cookie.cookie },
      payload: freshTelegramPayload({ id: 777111222 }),
    });
    assert.equal(link.statusCode, 200);
    const body = link.json();
    assert.equal(body.email, "linker@example.com", "same user, now with telegram");
    assert.equal(body.telegramLinked, true);

    // Exactly one user, carrying both email and telegram id.
    const { rows } = await pool.query("SELECT email, telegram_id FROM users");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, "linker@example.com");
    assert.equal(Number(rows[0].telegram_id), 777111222);
  });

  it("POST /api/auth/telegram returns 409 when the id is already linked to another user", async () => {
    // User A owns telegram id 888.
    await app.inject({
      method: "POST",
      url: "/api/auth/telegram",
      payload: freshTelegramPayload({ id: 888 }),
    });

    // User B signs in by email, then tries to claim the SAME telegram id.
    await app.inject({
      method: "POST",
      url: "/api/auth/magic-link",
      payload: { email: "userb@example.com" },
    });
    const verify = await app.inject({
      method: "GET",
      url: lastMagicLink.slice(BASE_URL.length),
    });
    const cookie = sessionCookieFromResponse(verify);

    const conflict = await app.inject({
      method: "POST",
      url: "/api/auth/telegram",
      headers: { cookie: cookie.cookie },
      payload: freshTelegramPayload({ id: 888 }),
    });
    assert.equal(conflict.statusCode, 409);

    // User B remains without a telegram id; the id still belongs to user A.
    const { rows } = await pool.query(
      "SELECT email, telegram_id FROM users ORDER BY email NULLS FIRST"
    );
    const userB = rows.find((r) => r.email === "userb@example.com");
    assert.equal(userB.telegram_id, null, "userb did not steal the link");
  });
});
