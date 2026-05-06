import assert from "node:assert/strict";
import test from "node:test";
import {
  hasPending,
  requestCode,
  resetPendingForTests,
  submitCode,
} from "../dist/runner/two-factor-store.js";

test("requestCode resolves when a matching Telegram user submits a code", async () => {
  resetPendingForTests();
  const pending = requestCode("run-101", 101, "sms", "Alex", Date.now() + 1_000);

  assert.equal(hasPending(101), true);
  assert.equal(submitCode(101, "123456"), true);
  assert.equal(await pending, "123456");
  assert.equal(hasPending(101), false);
});

test("requestCode supersedes an existing request for the same Telegram user", async () => {
  resetPendingForTests();
  const first = requestCode("run-102", 102, "sms", "Alex", Date.now() + 1_000);
  const firstRejected = assert.rejects(first, /Superseded/);

  const second = requestCode("run-102", 102, "email", "Alex", Date.now() + 1_000);
  assert.equal(submitCode(102, "654321"), true);

  await firstRejected;
  assert.equal(await second, "654321");
});

test("requestCode rejects when the deadline passes", async () => {
  resetPendingForTests();
  const pending = requestCode("run-103", 103, "sms", "Alex", Date.now() + 10);

  await assert.rejects(pending, /2FA timeout for Alex/);
  assert.equal(hasPending(103), false);
});

test("requestCode allows independent request ids for the same Telegram user", async () => {
  resetPendingForTests();
  const first = requestCode("run-104-a", 104, "sms", "Alex", Date.now() + 1_000);
  const second = requestCode("run-104-b", 104, "email", "Sam", Date.now() + 1_000);

  assert.equal(hasPending(104), true);
  assert.equal(submitCode(104, "111111"), true);
  assert.equal(await second, "111111");

  const firstRejected = assert.rejects(first, /Reset/);
  resetPendingForTests();
  await firstRejected;
});
