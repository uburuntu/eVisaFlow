import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelRequest,
  hasPending,
  requestCode,
  resetPendingForTests,
  resolveCode,
} from "../dist/runner/two-factor-store.js";

test("resolveCode resolves a request looked up directly by requestId", async () => {
  resetPendingForTests();
  const pending = requestCode({
    requestId: "run-101",
    method: "sms",
    memberName: "Alex",
    deadlineMs: Date.now() + 1_000,
  });

  assert.equal(hasPending("run-101"), true);
  assert.equal(hasPending("run-other"), false);
  assert.equal(resolveCode("run-101", "123456"), true);
  assert.equal(await pending, "123456");
  assert.equal(hasPending("run-101"), false);
});

test("requestCode supersedes an existing request id", async () => {
  resetPendingForTests();
  const first = requestCode({
    requestId: "run-102",
    method: "sms",
    memberName: "Alex",
    deadlineMs: Date.now() + 1_000,
  });
  const firstRejected = assert.rejects(first, /Superseded/);

  const second = requestCode({
    requestId: "run-102",
    method: "email",
    memberName: "Alex",
    deadlineMs: Date.now() + 1_000,
  });
  assert.equal(resolveCode("run-102", "654321"), true);

  await firstRejected;
  assert.equal(await second, "654321");
});

test("requestCode rejects when the deadline passes", async () => {
  resetPendingForTests();
  const pending = requestCode({
    requestId: "run-103",
    method: "sms",
    memberName: "Alex",
    deadlineMs: Date.now() + 10,
  });

  await assert.rejects(pending, /2FA timeout for Alex/);
  assert.equal(hasPending("run-103"), false);
});

test("requestCode rejects when its signal aborts", async () => {
  resetPendingForTests();
  const controller = new AbortController();
  const pending = requestCode({
    requestId: "run-105",
    method: "sms",
    memberName: "Alex",
    deadlineMs: Date.now() + 1_000,
    signal: controller.signal,
  });

  controller.abort(new Error("Stopped"));
  await assert.rejects(pending, /2FA cancelled for Alex/);
  assert.equal(hasPending("run-105"), false);
});

test("cancelRequest rejects a pending request", async () => {
  resetPendingForTests();
  const pending = requestCode({
    requestId: "run-106",
    method: "sms",
    memberName: "Alex",
    deadlineMs: Date.now() + 1_000,
  });

  assert.equal(cancelRequest("run-106", "No longer needed"), true);
  await assert.rejects(pending, /No longer needed/);
  assert.equal(hasPending("run-106"), false);
});

test("resolveCode returns false for an unknown requestId", () => {
  resetPendingForTests();
  assert.equal(resolveCode("does-not-exist", "000000"), false);
});

test("resolveCode integrates with a web run keyed by runId alone", async () => {
  resetPendingForTests();
  const pending = requestCode({
    requestId: "run-108",
    method: "sms",
    memberName: "Web User",
    deadlineMs: Date.now() + 1_000,
  });

  assert.equal(resolveCode("run-108", "999999"), true);
  assert.equal(await pending, "999999");
  // A second resolve for the same run is a no-op (the gate is already resolved).
  assert.equal(resolveCode("run-108", "111111"), false);
});
