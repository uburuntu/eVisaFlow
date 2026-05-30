import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verification of Telegram Login Widget authorization data.
 *
 * SECURITY model (non-negotiable), per Telegram's documented algorithm:
 *  1. Build the *data-check-string*: every received field EXCEPT `hash`, rendered
 *     as `key=value` lines, sorted alphabetically by key, joined with "\n".
 *  2. Derive the secret key = SHA-256(bot token) — the RAW 32 bytes, not hex.
 *  3. Compute HMAC-SHA256(data-check-string, secret key) and compare it to the
 *     provided `hash` in CONSTANT TIME. A mismatch means the payload was forged
 *     or tampered with and is rejected.
 *  4. Reject stale logins: `auth_date` (unix seconds) must be within a freshness
 *     window, so a captured-but-old signed payload cannot be replayed forever.
 *
 * This module is PURE (no I/O, no DB, no clock-coupled globals — `nowMs` is
 * injectable) so it is exhaustively unit-testable with a known token + payload.
 */

/** Default freshness window for `auth_date`: reject logins older than 1 day. */
export const DEFAULT_TELEGRAM_AUTH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The user fields a successful verification yields. `id` is Telegram's numeric
 * user id; the rest are optional profile fields Telegram may include. Only data
 * that was part of the signed (and verified) payload is surfaced.
 */
export interface TelegramAuthUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
}

export type VerifyTelegramResult =
  | { ok: true; user: TelegramAuthUser }
  | {
      ok: false;
      reason: "missing_hash" | "missing_auth_date" | "bad_signature" | "stale";
    };

export interface VerifyTelegramOptions {
  /** Max accepted age of `auth_date`. Defaults to {@link DEFAULT_TELEGRAM_AUTH_MAX_AGE_MS}. */
  maxAgeMs?: number;
  /** Current time in ms; injectable for deterministic tests. Defaults to `Date.now()`. */
  nowMs?: number;
}

/**
 * The raw payload from the Telegram Login Widget. Values arrive as strings over
 * the wire (query params / JSON), so we accept `string | number` and stringify
 * uniformly when building the data-check-string. Unknown extra fields are
 * tolerated and folded into the signature check (Telegram may add fields).
 */
export type TelegramAuthPayload = Record<string, string | number | undefined | null>;

/**
 * Builds the data-check-string: all entries except `hash`, with null/undefined
 * dropped, rendered `key=value`, sorted by key, joined with newlines. Stringifies
 * numbers so a value sent as a number or its string form verifies identically.
 */
function buildDataCheckString(payload: TelegramAuthPayload): string {
  return Object.keys(payload)
    .filter((key) => key !== "hash")
    .filter((key) => payload[key] !== undefined && payload[key] !== null)
    .sort()
    .map((key) => `${key}=${String(payload[key])}`)
    .join("\n");
}

/**
 * Verifies a Telegram Login payload against `botToken`.
 *
 * Returns `{ ok: true, user }` only when the HMAC matches AND `auth_date` is
 * fresh; otherwise `{ ok: false, reason }`. NEVER throws on malformed input — a
 * missing/odd `hash` or `auth_date` is reported as a failure reason, so callers
 * uniformly treat every non-ok result as "unauthenticated" without leaking which
 * check failed to end users.
 */
export function verifyTelegramLogin(
  payload: TelegramAuthPayload,
  botToken: string,
  options: VerifyTelegramOptions = {}
): VerifyTelegramResult {
  const providedHash = payload.hash;
  if (typeof providedHash !== "string" || providedHash.length === 0) {
    return { ok: false, reason: "missing_hash" };
  }

  // Telegram hashes are lowercase hex; normalize the provided value so a
  // differently-cased but otherwise valid hash still verifies.
  const providedHashHex = providedHash.toLowerCase();
  if (!/^[0-9a-f]+$/.test(providedHashHex)) {
    return { ok: false, reason: "bad_signature" };
  }

  const secretKey = createHash("sha256").update(botToken).digest();
  const dataCheckString = buildDataCheckString(payload);
  const expectedHashHex = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const expected = Buffer.from(expectedHashHex, "hex");
  const provided = Buffer.from(providedHashHex, "hex");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: "bad_signature" };
  }

  // Signature is valid → the payload is authentic. Now enforce freshness.
  const authDate = Number(payload.auth_date);
  if (!Number.isFinite(authDate)) {
    return { ok: false, reason: "missing_auth_date" };
  }
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_TELEGRAM_AUTH_MAX_AGE_MS;
  const ageMs = nowMs - authDate * 1000;
  if (ageMs > maxAgeMs) {
    return { ok: false, reason: "stale" };
  }

  const id = Number(payload.id);
  if (!Number.isInteger(id)) {
    return { ok: false, reason: "bad_signature" };
  }

  const asString = (value: string | number | undefined | null): string | undefined =>
    value === undefined || value === null ? undefined : String(value);

  return {
    ok: true,
    user: {
      id,
      first_name: asString(payload.first_name),
      last_name: asString(payload.last_name),
      username: asString(payload.username),
      photo_url: asString(payload.photo_url),
      auth_date: authDate,
    },
  };
}
