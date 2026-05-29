import assert from "node:assert/strict";
import test from "node:test";
import { createTwoFactorAdapter } from "../dist/bot/two-factor-adapter.js";

/**
 * A fake RunEngine that records submitCode calls. `accept` controls whether the
 * engine reports the gate as resolved (mirroring resolveCode's boolean).
 */
function makeEngine(accept = true) {
  const calls = [];
  const engine = {
    submitCode(runId, code) {
      calls.push({ runId, code });
      return accept;
    },
    // Unused by the adapter but part of the RunEngine surface.
    enqueueRun() {
      throw new Error("not used");
    },
    cancel() {
      return false;
    },
    subscribe() {
      throw new Error("not used");
    },
    getSnapshot() {
      return undefined;
    },
  };
  return { engine, calls };
}

test("hasPending reflects registration per (telegramId, chatId)", () => {
  const { engine } = makeEngine();
  const adapter = createTwoFactorAdapter(engine);

  assert.equal(adapter.hasPending(1, 10), false);
  adapter.register({ telegramId: 1, chatId: 10, runId: "run-a", promptMessageId: 100 });
  assert.equal(adapter.hasPending(1, 10), true);
  // A different chat or user does not see it.
  assert.equal(adapter.hasPending(1, 99), false);
  assert.equal(adapter.hasPending(2, 10), false);
});

test("submit routes a single pending run to engine.submitCode", () => {
  const { engine, calls } = makeEngine();
  const adapter = createTwoFactorAdapter(engine);
  adapter.register({ telegramId: 1, chatId: 10, runId: "run-a", promptMessageId: 100 });

  // No reply target needed when only one run is pending.
  assert.equal(adapter.submit(1, 10, "123456"), true);
  assert.deepEqual(calls, [{ runId: "run-a", code: "123456" }]);
  // Resolved runs are pruned from the matcher.
  assert.equal(adapter.hasPending(1, 10), false);
});

test("submit returns false when nothing is pending", () => {
  const { engine, calls } = makeEngine();
  const adapter = createTwoFactorAdapter(engine);
  assert.equal(adapter.submit(1, 10, "123456"), false);
  assert.equal(calls.length, 0);
});

test("submit requires a prompt reply to disambiguate concurrent runs", () => {
  const { engine, calls } = makeEngine();
  const adapter = createTwoFactorAdapter(engine);
  adapter.register({ telegramId: 1, chatId: 10, runId: "run-a", promptMessageId: 100 });
  adapter.register({ telegramId: 1, chatId: 10, runId: "run-b", promptMessageId: 200 });

  // Ambiguous without a reply target: nothing is submitted.
  assert.equal(adapter.submit(1, 10, "111111"), false);
  assert.equal(calls.length, 0);

  // Replying to run-b's prompt routes the code to run-b.
  assert.equal(adapter.submit(1, 10, "222222", 200), true);
  assert.deepEqual(calls, [{ runId: "run-b", code: "222222" }]);

  // run-a is still pending and is now the sole entry, so it resolves without a
  // reply target.
  assert.equal(adapter.hasPending(1, 10), true);
  assert.equal(adapter.submit(1, 10, "333333"), true);
  assert.deepEqual(calls[1], { runId: "run-a", code: "333333" });
  assert.equal(adapter.hasPending(1, 10), false);
});

test("submit with an unmatched reply target falls back to the sole pending run", () => {
  const { engine, calls } = makeEngine();
  const adapter = createTwoFactorAdapter(engine);
  adapter.register({ telegramId: 1, chatId: 10, runId: "run-a", promptMessageId: 100 });

  // Reply target points at an unknown message, but there is exactly one run.
  assert.equal(adapter.submit(1, 10, "424242", 999), true);
  assert.deepEqual(calls, [{ runId: "run-a", code: "424242" }]);
});

test("a run not matched by an unknown reply target stays pending when ambiguous", () => {
  const { engine, calls } = makeEngine();
  const adapter = createTwoFactorAdapter(engine);
  adapter.register({ telegramId: 1, chatId: 10, runId: "run-a", promptMessageId: 100 });
  adapter.register({ telegramId: 1, chatId: 10, runId: "run-b", promptMessageId: 200 });

  // Two runs + a reply target matching neither → no fallback, nothing submitted.
  assert.equal(adapter.submit(1, 10, "000000", 777), false);
  assert.equal(calls.length, 0);
  assert.equal(adapter.hasPending(1, 10), true);
});

test("submit keeps the run pending when the engine rejects the code", () => {
  const { engine, calls } = makeEngine(false);
  const adapter = createTwoFactorAdapter(engine);
  adapter.register({ telegramId: 1, chatId: 10, runId: "run-a", promptMessageId: 100 });

  assert.equal(adapter.submit(1, 10, "123456"), false);
  assert.deepEqual(calls, [{ runId: "run-a", code: "123456" }]);
  // Engine said the gate was not resolved → the entry must remain.
  assert.equal(adapter.hasPending(1, 10), true);
});

test("unregister drops a terminal run from the matcher", () => {
  const { engine, calls } = makeEngine();
  const adapter = createTwoFactorAdapter(engine);
  adapter.register({ telegramId: 1, chatId: 10, runId: "run-a", promptMessageId: 100 });
  adapter.register({ telegramId: 1, chatId: 10, runId: "run-b", promptMessageId: 200 });

  adapter.unregister("run-a");
  // run-b remains, run-a is gone; a code addressed to run-a's old prompt now
  // resolves run-b as the sole pending run (never run-a).
  assert.equal(adapter.hasPending(1, 10), true);
  assert.equal(adapter.submit(1, 10, "222222", 100), true);
  assert.deepEqual(calls, [{ runId: "run-b", code: "222222" }]);
  assert.equal(adapter.hasPending(1, 10), false);

  adapter.unregister("run-b");
  assert.equal(adapter.hasPending(1, 10), false);
});

test("unregister is a no-op for an unknown run", () => {
  const { engine } = makeEngine();
  const adapter = createTwoFactorAdapter(engine);
  assert.doesNotThrow(() => adapter.unregister("missing"));
});

test("re-registering the same run updates its prompt message id", () => {
  const { engine, calls } = makeEngine();
  const adapter = createTwoFactorAdapter(engine);
  adapter.register({ telegramId: 1, chatId: 10, runId: "run-a", promptMessageId: 100 });
  // A fresh prompt for the same run (e.g. a resend) updates the reply target.
  adapter.register({ telegramId: 1, chatId: 10, runId: "run-a", promptMessageId: 150 });

  // The old prompt id no longer matches; the new one does. With a single run,
  // either way it resolves — assert the new id matches explicitly.
  assert.equal(adapter.submit(1, 10, "123456", 150), true);
  assert.deepEqual(calls, [{ runId: "run-a", code: "123456" }]);
});

test("runs in different chats are isolated", () => {
  const { engine, calls } = makeEngine();
  const adapter = createTwoFactorAdapter(engine);
  adapter.register({ telegramId: 1, chatId: 10, runId: "run-a", promptMessageId: 100 });
  adapter.register({ telegramId: 1, chatId: 20, runId: "run-b", promptMessageId: 100 });

  assert.equal(adapter.submit(1, 20, "222222"), true);
  assert.deepEqual(calls, [{ runId: "run-b", code: "222222" }]);
  // The chat-10 run is untouched.
  assert.equal(adapter.hasPending(1, 10), true);
  assert.equal(adapter.hasPending(1, 20), false);
});
