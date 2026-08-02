import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitiveText } from "../dist/utils/logger.js";

test("service logger redacts sensitive canaries from errors", () => {
  const redacted = redactSensitiveText(
    "Passport 991234567 DOB 1980-03-31 share W12 345 678 email person@example.test Authorization Bearer eyJhbGciOiJIUzI1Ni.secret and https://example.test/path?token=secret"
  );

  for (const canary of [
    "991234567",
    "1980-03-31",
    "W12 345 678",
    "person@example.test",
    "eyJhbGciOiJIUzI1Ni.secret",
    "token=secret",
  ]) {
    assert.equal(redacted.includes(canary), false, `leaked ${canary}`);
  }
  assert.match(redacted, /\[share-code\]/);
  assert.match(redacted, /\[date\]/);
  assert.match(redacted, /Bearer \[redacted\]/);
});
