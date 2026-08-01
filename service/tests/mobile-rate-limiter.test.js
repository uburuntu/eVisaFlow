import assert from "node:assert/strict";
import test from "node:test";
import { MobileRateLimiter } from "../dist/api/mobile-rate-limiter.js";

test("mobile rate limiter resets fixed windows and reports retry delay", () => {
  const limiter = new MobileRateLimiter();
  assert.equal(limiter.consume("user:runs", 2, 10_000, 1_000), null);
  assert.equal(limiter.consume("user:runs", 2, 10_000, 2_000), null);
  assert.equal(limiter.consume("user:runs", 2, 10_000, 2_500), 9);
  assert.equal(limiter.consume("user:runs", 2, 10_000, 11_000), null);
});

test("mobile rate limiter bounds its in-memory key set", () => {
  const limiter = new MobileRateLimiter(2);
  limiter.consume("one", 1, 10_000, 1_000);
  limiter.consume("two", 1, 10_000, 1_000);
  limiter.consume("three", 1, 10_000, 1_000);

  assert.equal(limiter.consume("one", 1, 10_000, 1_001), null);
  assert.equal(limiter.consume("three", 1, 10_000, 1_001), 10);
});
