import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeUrl } from "../scripts/sanitize-url.js";

test("sanitizeUrl strips query parameters and fragments from logs", () => {
  assert.equal(
    sanitizeUrl("https://example.test/auth?state=secret&nonce=secret#callback"),
    "https://example.test/auth"
  );
  assert.equal(sanitizeUrl("/relative?token=secret#fragment"), "/relative");
});
