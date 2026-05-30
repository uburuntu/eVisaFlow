import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  consumeMagicLink,
  DEFAULT_MAGIC_LINK_TTL_MS,
  generateMagicLinkToken,
  issueMagicLink,
} from "../dist/auth/magic-link.js";
import { hashSessionToken } from "../dist/auth/session.js";
import { schema } from "../dist/db/schema.js";

// Exercises the magic-link issue/consume layer. The pure token generator runs
// everywhere; the issue→consume behavior is DB-backed and SKIPPED unless
// DATABASE_URL is set and reachable (matching db.test.js / session.test.js).
//
// SAFETY: point DATABASE_URL only at a local/ephemeral Postgres. This creates an
// isolated throwaway schema and drops it afterwards; it never touches the
// `public` schema or any production data.

const DATABASE_URL = process.env.DATABASE_URL;
const TEST_SCHEMA = `evisaflow_magiclink_${process.pid}_${Date.now().toString(36)}`;

// magic_link_tokens has no FK to users, so this is all the table the consume
// path needs. (issueMagicLink normalizes the email; we assert on that too.)
const SCHEMA_DDL = `
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

// --- Pure helpers (no DB) — always run. -------------------------------------

describe("magic-link token generation (pure)", () => {
  it("generates high-entropy, distinct, url-safe tokens", () => {
    const a = generateMagicLinkToken();
    const b = generateMagicLinkToken();
    assert.notEqual(a, b);
    assert.match(a, /^[A-Za-z0-9_-]+$/, "url-safe base64url, no padding");
    assert.ok(a.length >= 43, "32 bytes → ≥43 base64url chars");
  });

  it("exposes a 15-minute default TTL", () => {
    assert.equal(DEFAULT_MAGIC_LINK_TTL_MS, 15 * 60 * 1000);
  });
});

// --- DB-backed behavior — skipped without a reachable Postgres. -------------

const skip = await probeDatabase();

describe("magic-link issue/consume (Drizzle + pg)", { skip: skip ?? false }, () => {
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
    await pool.query("TRUNCATE magic_link_tokens RESTART IDENTITY");
  });

  it("issue stores ONLY the hash (raw token never persisted) and consume returns the email", async () => {
    const token = await issueMagicLink(db, "Person@Example.com");

    // The stored row carries the hash of the token, never the token itself, and
    // the email is normalized to lower-case.
    const { rows } = await pool.query("SELECT email, token_hash FROM magic_link_tokens");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, "person@example.com", "email normalized");
    assert.equal(rows[0].token_hash, hashSessionToken(token));
    assert.notEqual(rows[0].token_hash, token, "raw token is not stored");

    const email = await consumeMagicLink(db, token);
    assert.equal(email, "person@example.com");
  });

  it("consume is single-use: a second consume of the same token is rejected", async () => {
    const token = await issueMagicLink(db, "single@example.com");
    assert.equal(await consumeMagicLink(db, token), "single@example.com");
    assert.equal(await consumeMagicLink(db, token), null, "second consume → null");
  });

  it("an expired token cannot be consumed", async () => {
    // TTL in the past → already expired at issue time.
    const token = await issueMagicLink(db, "expired@example.com", -1000);
    assert.equal(await consumeMagicLink(db, token), null);
  });

  it("an unknown or blank token is rejected without revealing anything", async () => {
    assert.equal(await consumeMagicLink(db, generateMagicLinkToken()), null);
    assert.equal(await consumeMagicLink(db, ""), null);
  });

  it("normalizes the email the same way at issue and consume", async () => {
    const token = await issueMagicLink(db, "  MixedCase@Example.COM  ");
    const email = await consumeMagicLink(db, token);
    assert.equal(email, "mixedcase@example.com");
  });
});
