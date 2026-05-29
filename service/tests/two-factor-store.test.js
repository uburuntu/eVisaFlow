import assert from "node:assert/strict";
import test from "node:test";
import {
  bindTelegramRoute,
  cancelRequest,
  hasPending,
  requestCode,
  resetPendingForTests,
  resolveCode,
  setPromptMessageId,
  submitCode,
} from "../dist/runner/two-factor-store.js";

test("requestCode resolves when a matching Telegram user and chat submit a code", async () => {
  resetPendingForTests();
  const pending = requestCode({
    requestId: "run-101",
    telegramId: 101,
    chatId: 1001,
    method: "sms",
    memberName: "Alex",
    deadlineMs: Date.now() + 1_000,
  });

  assert.equal(hasPending(101), true);
  assert.equal(hasPending(101, 1001), true);
  assert.equal(hasPending(101, 2002), false);
  assert.equal(submitCode({ telegramId: 101, chatId: 1001, code: "123456" }), true);
  assert.equal(await pending, "123456");
  assert.equal(hasPending(101), false);
});

test("requestCode supersedes an existing request id", async () => {
  resetPendingForTests();
  const first = requestCode({
    requestId: "run-102",
    telegramId: 102,
    chatId: 1002,
    method: "sms",
    memberName: "Alex",
    deadlineMs: Date.now() + 1_000,
  });
  const firstRejected = assert.rejects(first, /Superseded/);

  const second = requestCode({
    requestId: "run-102",
    telegramId: 102,
    chatId: 1002,
    method: "email",
    memberName: "Alex",
    deadlineMs: Date.now() + 1_000,
  });
  assert.equal(submitCode({ telegramId: 102, chatId: 1002, code: "654321" }), true);

  await firstRejected;
  assert.equal(await second, "654321");
});

test("requestCode rejects when the deadline passes", async () => {
  resetPendingForTests();
  const pending = requestCode({
    requestId: "run-103",
    telegramId: 103,
    chatId: 1003,
    method: "sms",
    memberName: "Alex",
    deadlineMs: Date.now() + 10,
  });

  await assert.rejects(pending, /2FA timeout for Alex/);
  assert.equal(hasPending(103), false);
});

test("multiple pending requests require a prompt reply to disambiguate", async () => {
  resetPendingForTests();
  const first = requestCode({
    requestId: "run-104-a",
    telegramId: 104,
    chatId: 1004,
    method: "sms",
    memberName: "Alex",
    deadlineMs: Date.now() + 1_000,
  });
  const second = requestCode({
    requestId: "run-104-b",
    telegramId: 104,
    chatId: 1004,
    method: "email",
    memberName: "Sam",
    deadlineMs: Date.now() + 1_000,
  });

  assert.equal(setPromptMessageId("run-104-a", 7001), true);
  assert.equal(setPromptMessageId("run-104-b", 7002), true);
  assert.equal(submitCode({ telegramId: 104, chatId: 1004, code: "111111" }), false);
  assert.equal(
    submitCode({
      telegramId: 104,
      chatId: 1004,
      code: "222222",
      replyToMessageId: 7002,
    }),
    true
  );
  assert.equal(await second, "222222");

  const firstRejected = assert.rejects(first, /Reset/);
  resetPendingForTests();
  await firstRejected;
});

test("requestCode rejects when its signal aborts", async () => {
  resetPendingForTests();
  const controller = new AbortController();
  const pending = requestCode({
    requestId: "run-105",
    telegramId: 105,
    chatId: 1005,
    method: "sms",
    memberName: "Alex",
    deadlineMs: Date.now() + 1_000,
    signal: controller.signal,
  });

  controller.abort(new Error("Stopped"));
  await assert.rejects(pending, /2FA cancelled for Alex/);
  assert.equal(hasPending(105), false);
});

test("cancelRequest rejects a pending request", async () => {
  resetPendingForTests();
  const pending = requestCode({
    requestId: "run-106",
    telegramId: 106,
    chatId: 1006,
    method: "sms",
    memberName: "Alex",
    deadlineMs: Date.now() + 1_000,
  });

  assert.equal(cancelRequest("run-106", "No longer needed"), true);
  await assert.rejects(pending, /No longer needed/);
});

test("resolveCode resolves a request looked up directly by requestId", async () => {
  resetPendingForTests();
  const pending = requestCode({
    requestId: "run-107",
    method: "email",
    memberName: "Alex",
    deadlineMs: Date.now() + 1_000,
  });

  assert.equal(resolveCode("run-107", "424242"), true);
  assert.equal(await pending, "424242");
  assert.equal(hasPending(107), false);
});

test("resolveCode returns false for an unknown requestId", () => {
  resetPendingForTests();
  assert.equal(resolveCode("does-not-exist", "000000"), false);
});

test("resolveCode integrates with a web run that omits telegramId and chatId", async () => {
  resetPendingForTests();
  const pending = requestCode({
    requestId: "run-108",
    method: "sms",
    memberName: "Web User",
    deadlineMs: Date.now() + 1_000,
  });

  assert.equal(resolveCode("run-108", "999999"), true);
  assert.equal(await pending, "999999");
  assert.equal(resolveCode("run-108", "111111"), false);
});

test("bindTelegramRoute lets the bot reply-matching middleware route a runId-keyed request", async () => {
  resetPendingForTests();
  // The engine's run-job creates the request keyed by runId alone (no Telegram
  // routing), exactly as createEvisaRunJob does.
  const pending = requestCode({
    requestId: "run-109",
    method: "sms",
    memberName: "Alex",
    deadlineMs: Date.now() + 1_000,
  });

  // Before binding, the Telegram reply-matching path cannot see the request.
  assert.equal(hasPending(109, 1009), false);
  assert.equal(submitCode({ telegramId: 109, chatId: 1009, code: "000000" }), false);

  // The bot binds the delivery context after sending the 2FA prompt.
  assert.equal(
    bindTelegramRoute("run-109", {
      telegramId: 109,
      chatId: 1009,
      promptMessageId: 7100,
    }),
    true
  );

  // Now hasPending + submitCode (the middleware path) resolve the same request.
  assert.equal(hasPending(109, 1009), true);
  assert.equal(
    submitCode({
      telegramId: 109,
      chatId: 1009,
      code: "424242",
      replyToMessageId: 7100,
    }),
    true
  );
  assert.equal(await pending, "424242");
  assert.equal(hasPending(109, 1009), false);
});

test("bindTelegramRoute returns false for an unknown requestId", () => {
  resetPendingForTests();
  assert.equal(
    bindTelegramRoute("missing", { telegramId: 1, chatId: 2, promptMessageId: 3 }),
    false
  );
});
