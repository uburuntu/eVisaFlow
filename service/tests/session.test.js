import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import cookie from "@fastify/cookie";
import { drizzle } from "drizzle-orm/node-postgres";
import Fastify from "fastify";
import { Pool } from "pg";
import {
  DEFAULT_SESSION_TTL_MS,
  destroySession,
  generateSessionToken,
  hashSessionToken,
  readSessionUser,
  SESSION_COOKIE,
  safeHashEqual,
  startSession,
} from "../dist/auth/session.js";
import { consumeToken, createToken } from "../dist/db/magic-link-tokens.js";
import { schema } from "../dist/db/schema.js";
import {
  createSession,
  deleteExpiredSessions,
  deleteSession,
  findValidSessionByTokenHash,
} from "../dist/db/sessions.js";
import { getVault, upsertVault } from "../dist/db/user-vault.js";
import { upsertUser } from "../dist/db/users.js";

// Exercises the hashed-session auth layer + its DB accessors against a live
// Postgres. SKIPPED unless DATABASE_URL is set and reachable, so the suite stays
// green in environments without a database (matching db.test.js).
//
// SAFETY: point DATABASE_URL only at a local/ephemeral Postgres. This creates an
// isolated throwaway schema and drops it afterwards; it never touches the
// `public` schema or any production data.

const DATABASE_URL = process.env.DATABASE_URL;
const TEST_SCHEMA = `evisaflow_session_${process.pid}_${Date.now().toString(36)}`;

// Slice of the live schema (through migration 004) the auth layer needs: users +
// the three web-auth tables, created inside the isolated test schema.
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

/** Parses a Set-Cookie header value into name, value, and lower-cased attrs. */
function parseSetCookie(header) {
  const parts = header.split(";").map((p) => p.trim());
  const [pair, ...attrs] = parts;
  const eq = pair.indexOf("=");
  return {
    name: pair.slice(0, eq),
    value: pair.slice(eq + 1),
    attrs: attrs.map((a) => a.toLowerCase()),
  };
}

// --- Pure helpers (no DB) — always run. -------------------------------------

describe("session token helpers (pure)", () => {
  it("hashSessionToken is deterministic sha256 hex and not the raw token", () => {
    const token = generateSessionToken();
    const h1 = hashSessionToken(token);
    const h2 = hashSessionToken(token);
    assert.equal(h1, h2, "deterministic");
    assert.match(h1, /^[0-9a-f]{64}$/, "64-char hex sha256");
    assert.notEqual(h1, token, "hash is not the raw token");
  });

  it("generateSessionToken returns high-entropy, distinct, url-safe tokens", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    assert.notEqual(a, b, "two tokens differ");
    assert.match(a, /^[A-Za-z0-9_-]+$/, "url-safe base64url, no padding");
    // 32 bytes → 43 base64url chars.
    assert.ok(a.length >= 43);
  });

  it("safeHashEqual is true for equal hashes and false otherwise", () => {
    const token = generateSessionToken();
    const h = hashSessionToken(token);
    assert.equal(safeHashEqual(h, h), true);
    assert.equal(safeHashEqual(h, hashSessionToken(generateSessionToken())), false);
    assert.equal(safeHashEqual(h, "abc"), false, "differing length → false");
  });
});

// --- DB-backed behavior — skipped without a reachable Postgres. -------------

const skip = await probeDatabase();

describe("session auth (Drizzle + pg)", { skip: skip ?? false }, () => {
  let bootstrap;
  let pool;
  let db;

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
      "TRUNCATE magic_link_tokens, sessions, user_vault, users RESTART IDENTITY CASCADE"
    );
  });

  async function makeUser(telegramId = 5001) {
    return upsertUser(db, telegramId, "Ada", "ada_handle", 30);
  }

  it("createSession stores ONLY the hash; findValid resolves it; raw token absent", async () => {
    const user = await makeUser();
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    const created = await createSession(db, {
      user_id: user.id,
      token_hash: tokenHash,
      expires_at: expiresAt,
    });
    assert.equal(created.user_id, user.id);
    assert.equal(created.token_hash, tokenHash);

    // The raw token must never appear in the row.
    const { rows } = await pool.query(
      "SELECT token_hash FROM sessions WHERE user_id = $1",
      [user.id]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token_hash, tokenHash);
    assert.notEqual(rows[0].token_hash, token);

    const found = await findValidSessionByTokenHash(db, tokenHash);
    assert.ok(found);
    assert.equal(found.user_id, user.id);

    // Unknown hash → null (no signal about existence).
    assert.equal(await findValidSessionByTokenHash(db, hashSessionToken("nope")), null);
  });

  it("findValidSessionByTokenHash treats an expired session as absent", async () => {
    const user = await makeUser();
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    await createSession(db, {
      user_id: user.id,
      token_hash: tokenHash,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal(await findValidSessionByTokenHash(db, tokenHash), null);
  });

  it("deleteSession removes the row (logout) and is idempotent", async () => {
    const user = await makeUser();
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    await createSession(db, {
      user_id: user.id,
      token_hash: tokenHash,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(await deleteSession(db, tokenHash), true);
    assert.equal(await findValidSessionByTokenHash(db, tokenHash), null);
    assert.equal(await deleteSession(db, tokenHash), false, "second delete is a no-op");
  });

  it("deleteExpiredSessions removes only past-due rows", async () => {
    const user = await makeUser();
    await createSession(db, {
      user_id: user.id,
      token_hash: hashSessionToken(generateSessionToken()),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const liveHash = hashSessionToken(generateSessionToken());
    await createSession(db, {
      user_id: user.id,
      token_hash: liveHash,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const removed = await deleteExpiredSessions(db, new Date().toISOString());
    assert.equal(removed, 1);
    assert.ok(await findValidSessionByTokenHash(db, liveHash), "live session survives");
  });

  it("startSession sets an HttpOnly; Secure; SameSite=Lax; Path=/ cookie with Max-Age", async () => {
    const user = await makeUser();
    const app = Fastify();
    await app.register(cookie);
    let issuedToken;
    app.get("/login", async (_req, reply) => {
      issuedToken = await startSession(db, reply, user.id, 1000 * 60 * 60);
      return reply.send({ ok: true });
    });
    try {
      const res = await app.inject({ method: "GET", url: "/login" });
      assert.equal(res.statusCode, 200);
      const raw = res.headers["set-cookie"];
      const header = Array.isArray(raw) ? raw[0] : raw;
      assert.ok(header, "Set-Cookie present");
      const parsed = parseSetCookie(header);
      assert.equal(parsed.name, SESSION_COOKIE);
      assert.equal(parsed.value, issuedToken, "cookie carries the raw token");
      assert.ok(parsed.attrs.includes("httponly"), "HttpOnly");
      assert.ok(parsed.attrs.includes("secure"), "Secure");
      assert.ok(parsed.attrs.includes("samesite=lax"), "SameSite=Lax");
      assert.ok(parsed.attrs.includes("path=/"), "Path=/");
      assert.ok(
        parsed.attrs.some((a) => a.startsWith("max-age=")),
        "Max-Age set from expiry"
      );

      // The persisted row stores the hash of the issued token, never the token.
      const persisted = await findValidSessionByTokenHash(
        db,
        hashSessionToken(issuedToken)
      );
      assert.ok(persisted);
      assert.equal(persisted.user_id, user.id);
    } finally {
      await app.close();
    }
  });

  it("readSessionUser resolves the user from a cookie and 401-paths return null", async () => {
    const user = await makeUser();
    const token = await (async () => {
      const t = generateSessionToken();
      await createSession(db, {
        user_id: user.id,
        token_hash: hashSessionToken(t),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      return t;
    })();

    // Valid cookie → the owning user.
    const okUser = await readSessionUser(db, { cookies: { [SESSION_COOKIE]: token } });
    assert.ok(okUser);
    assert.equal(okUser.id, user.id);

    // No cookie → null.
    assert.equal(await readSessionUser(db, { cookies: {} }), null);
    // Unknown token → null.
    assert.equal(
      await readSessionUser(db, {
        cookies: { [SESSION_COOKIE]: generateSessionToken() },
      }),
      null
    );
  });

  it("destroySession deletes the row and clears the cookie", async () => {
    const user = await makeUser();
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    await createSession(db, {
      user_id: user.id,
      token_hash: tokenHash,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const cleared = [];
    const reply = {
      clearCookie(name, opts) {
        cleared.push({ name, opts });
        return reply;
      },
    };
    await destroySession(db, { cookies: { [SESSION_COOKIE]: token } }, reply);
    assert.equal(await findValidSessionByTokenHash(db, tokenHash), null);
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0].name, SESSION_COOKIE);
    assert.equal(cleared[0].opts?.path, "/");
  });

  it("DEFAULT_SESSION_TTL_MS is a sane 30-day default", () => {
    assert.equal(DEFAULT_SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000);
  });

  it("magic-link consumeToken is single-use and rejects expired", async () => {
    const email = "person@example.com";
    const token = generateSessionToken();
    await createToken(db, {
      email,
      token_hash: hashSessionToken(token),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const first = await consumeToken(db, hashSessionToken(token));
    assert.ok(first, "first consume succeeds");
    assert.equal(first.email, email);
    assert.ok(first.consumed_at, "marked consumed");

    const second = await consumeToken(db, hashSessionToken(token));
    assert.equal(second, null, "second consume is rejected (single-use)");

    // An expired token is never consumable.
    const expiredToken = generateSessionToken();
    await createToken(db, {
      email,
      token_hash: hashSessionToken(expiredToken),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    assert.equal(await consumeToken(db, hashSessionToken(expiredToken)), null);
  });

  it("user-vault upsert stores opaque blobs and getVault round-trips them", async () => {
    const user = await makeUser();
    const pub = Buffer.from([1, 2, 3, 4]);
    const wrapped = Buffer.from([5, 6, 7, 8]);
    const salt = Buffer.from([9, 10]);

    const saved = await upsertVault(db, {
      user_id: user.id,
      public_key: pub,
      wrapped_private_key: wrapped,
      kdf_salt: salt,
      kdf_params: { algorithm: "argon2id", opslimit: 2, memlimit: 67108864 },
    });
    assert.ok(saved.public_key.equals(pub));
    assert.equal(saved.recovery_wrapped_key, null);

    const fetched = await getVault(db, user.id);
    assert.ok(fetched);
    assert.ok(fetched.public_key.equals(pub));
    assert.ok(fetched.wrapped_private_key.equals(wrapped));
    assert.deepEqual(fetched.kdf_params, {
      algorithm: "argon2id",
      opslimit: 2,
      memlimit: 67108864,
    });

    // Upsert replaces in place (1:1) and can add the recovery copy.
    const recovery = Buffer.from([11, 12]);
    const pub2 = Buffer.from([13, 14]);
    await upsertVault(db, {
      user_id: user.id,
      public_key: pub2,
      wrapped_private_key: wrapped,
      kdf_salt: salt,
      kdf_params: {},
      recovery_wrapped_key: recovery,
    });
    const updated = await getVault(db, user.id);
    assert.ok(updated.public_key.equals(pub2), "public key replaced");
    assert.ok(updated.recovery_wrapped_key?.equals(recovery), "recovery copy stored");

    assert.equal(await getVault(db, "00000000-0000-0000-0000-000000000000"), null);
  });
});
