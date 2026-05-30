import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  DEFAULT_TELEGRAM_AUTH_MAX_AGE_MS,
  verifyTelegramLogin,
} from "../dist/auth/telegram-verify.js";

// Exercises the pure Telegram Login verifier. No DB / network: a known bot token
// and payload are used, and the VALID hash is computed here with an independent
// inline implementation of Telegram's documented algorithm so the assertions are
// a genuine cross-check of the module, not a tautology against its own output.

const BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"; // sample, not real

/**
 * Reference implementation of Telegram's signing per the official spec:
 *   secret = SHA256(bot token) [raw 32 bytes]
 *   data-check-string = sorted "key=value" lines (excluding hash), joined by \n
 *   hash = HMAC_SHA256(data-check-string, secret) as lowercase hex
 */
function signTelegramPayload(fields, botToken) {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secret = createHash("sha256").update(botToken).digest();
  return createHmac("sha256", secret).update(dataCheckString).digest("hex");
}

/** A fresh, validly-signed payload at `authDateSec`. */
function makeSignedPayload(authDateSec) {
  const fields = {
    id: 987654321,
    first_name: "Ada",
    username: "ada_lovelace",
    auth_date: authDateSec,
  };
  return { ...fields, hash: signTelegramPayload(fields, BOT_TOKEN) };
}

describe("verifyTelegramLogin", () => {
  it("accepts a correctly-signed, fresh payload and returns the user", () => {
    const nowMs = 1_700_000_000_000;
    const authDateSec = Math.floor(nowMs / 1000) - 60; // 1 minute ago
    const payload = makeSignedPayload(authDateSec);

    const result = verifyTelegramLogin(payload, BOT_TOKEN, { nowMs });
    assert.equal(result.ok, true);
    assert.equal(result.user.id, 987654321);
    assert.equal(result.user.first_name, "Ada");
    assert.equal(result.user.username, "ada_lovelace");
    assert.equal(result.user.auth_date, authDateSec);
  });

  it("rejects a tampered field (id changed after signing) → bad_signature", () => {
    const nowMs = 1_700_000_000_000;
    const authDateSec = Math.floor(nowMs / 1000) - 60;
    const payload = makeSignedPayload(authDateSec);

    // Flip a field the attacker would want to change while keeping the old hash.
    const tampered = { ...payload, id: 111111111 };
    const result = verifyTelegramLogin(tampered, BOT_TOKEN, { nowMs });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "bad_signature");
  });

  it("rejects when signed with the wrong bot token → bad_signature", () => {
    const nowMs = 1_700_000_000_000;
    const authDateSec = Math.floor(nowMs / 1000) - 60;
    const fields = { id: 5, first_name: "Bo", auth_date: authDateSec };
    const payload = {
      ...fields,
      hash: signTelegramPayload(fields, "999999:WRONG-token"),
    };
    const result = verifyTelegramLogin(payload, BOT_TOKEN, { nowMs });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "bad_signature");
  });

  it("rejects a stale payload (auth_date older than the window) → stale", () => {
    const nowMs = 1_700_000_000_000;
    // 2 days old, beyond the default 1-day window — but validly signed, proving
    // freshness is enforced AFTER the signature check.
    const authDateSec = Math.floor(nowMs / 1000) - 2 * 24 * 60 * 60;
    const payload = makeSignedPayload(authDateSec);

    const result = verifyTelegramLogin(payload, BOT_TOKEN, { nowMs });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "stale");
  });

  it("honours a custom freshness window", () => {
    const nowMs = 1_700_000_000_000;
    const authDateSec = Math.floor(nowMs / 1000) - 120; // 2 minutes ago
    const payload = makeSignedPayload(authDateSec);

    // 1-minute window → the 2-minute-old payload is stale.
    const strict = verifyTelegramLogin(payload, BOT_TOKEN, {
      nowMs,
      maxAgeMs: 60_000,
    });
    assert.equal(strict.ok, false);
    assert.equal(strict.reason, "stale");

    // 1-hour window → accepted.
    const lax = verifyTelegramLogin(payload, BOT_TOKEN, {
      nowMs,
      maxAgeMs: 60 * 60_000,
    });
    assert.equal(lax.ok, true);
  });

  it("rejects a missing hash without throwing", () => {
    const result = verifyTelegramLogin({ id: 1, auth_date: 1 }, BOT_TOKEN);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing_hash");
  });

  it("rejects a validly-signed payload that lacks auth_date → missing_auth_date", () => {
    // Sign a payload with no auth_date, then verify: signature passes, freshness
    // check finds no auth_date.
    const fields = { id: 7, first_name: "No-Date" };
    const payload = { ...fields, hash: signTelegramPayload(fields, BOT_TOKEN) };
    const result = verifyTelegramLogin(payload, BOT_TOKEN, { nowMs: 1_700_000_000_000 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing_auth_date");
  });

  it("verifies identically whether numeric fields arrive as numbers or strings", () => {
    const nowMs = 1_700_000_000_000;
    const authDateSec = Math.floor(nowMs / 1000) - 30;
    // Sign with numeric values (as the reference impl stringifies them anyway)…
    const numeric = makeSignedPayload(authDateSec);
    // …then present every value as a string over the wire.
    const asStrings = Object.fromEntries(
      Object.entries(numeric).map(([k, v]) => [k, String(v)])
    );
    const result = verifyTelegramLogin(asStrings, BOT_TOKEN, { nowMs });
    assert.equal(result.ok, true);
    assert.equal(result.user.id, 987654321);
  });

  it("exposes a 1-day default freshness window", () => {
    assert.equal(DEFAULT_TELEGRAM_AUTH_MAX_AGE_MS, 24 * 60 * 60 * 1000);
  });
});
