import { randomBytes } from "node:crypto";
import type { Db } from "../db/client.js";
import { consumeToken, createToken } from "../db/magic-link-tokens.js";
import { normalizeEmail } from "../db/users.js";
import { hashSessionToken } from "./session.js";

/**
 * Email magic-link issue/consume.
 *
 * SECURITY model (non-negotiable):
 * - The token is high-entropy random bytes generated server-side. ONLY its
 *   SHA-256 hash is persisted (`magic_link_tokens.token_hash`); the raw token
 *   lives solely in the emailed link, so a database compromise yields no usable
 *   links and the server can never reconstruct one.
 * - Tokens are SINGLE-USE (`consumed_at`, set atomically by {@link consumeToken})
 *   and SHORT-TTL (`expires_at`). An unknown, already-consumed, or expired token
 *   is indistinguishable on consume (all → null), revealing nothing.
 * - {@link issueMagicLink} returns the raw token to the caller ONLY so it can be
 *   placed in the verification URL/email; it is never logged or stored raw.
 */

/** 32 random bytes → 43-char base64url token (~256 bits of entropy). */
const TOKEN_BYTES = 32;

/** Default magic-link lifetime: 15 minutes. */
export const DEFAULT_MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

/** Generates a fresh, high-entropy magic-link token (URL-safe, no padding). */
export function generateMagicLinkToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Issues a magic-link token for `email`: persists ONLY its hash with an
 * `expires_at` of now + `ttlMs`, and returns the raw token for the caller to put
 * in the verification link. The email is normalized (trim + lower-case) so it
 * matches the user lookup performed at verify time. `ttlMs` defaults to
 * {@link DEFAULT_MAGIC_LINK_TTL_MS}.
 *
 * NOTE: this issues unconditionally (it does NOT check whether the email already
 * has an account) — that is deliberate. The route always returns 204 regardless,
 * so issuing a token for a never-before-seen address leaks nothing and lets a
 * brand-new user sign up by clicking the link (the user is created at verify).
 */
export async function issueMagicLink(
  db: Db,
  email: string,
  ttlMs: number = DEFAULT_MAGIC_LINK_TTL_MS
): Promise<string> {
  const token = generateMagicLinkToken();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await createToken(db, {
    email: normalizeEmail(email),
    token_hash: hashSessionToken(token),
    expires_at: expiresAt,
  });
  return token;
}

/**
 * Consumes a magic-link token (single-use). Returns the normalized email the
 * token was issued for when it is currently valid (unconsumed AND unexpired), or
 * null otherwise. The validate-and-mark-consumed step is one atomic statement in
 * {@link consumeToken}, so a token can never be redeemed twice even under a race.
 * Callers MUST treat null uniformly (unknown / consumed / expired) and reveal
 * nothing about which it was.
 */
export async function consumeMagicLink(db: Db, token: string): Promise<string | null> {
  if (!token) return null;
  const row = await consumeToken(db, hashSessionToken(token));
  return row ? row.email : null;
}
