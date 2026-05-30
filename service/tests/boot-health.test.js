import assert from "node:assert/strict";
import test from "node:test";
import { healthSnapshot } from "../dist/index.js";

// Unit tests for the bot-aware readiness gating in index.ts. `healthSnapshot`
// maps the live RuntimeState to the health snapshot served by /ready, and the
// boot module's `main()` is guarded so importing it here does NOT start the
// service. The core web-first contract under test: a pure-web deployment
// (ENABLE_BOT=false) reports ready WITHOUT a bot and never advertises Telegram.

const baseState = {
  ready: true,
  shuttingDown: false,
  startedAt: new Date(0).toISOString(),
  botEnabled: false,
  telegramReady: false,
  telegramUsername: undefined,
  dbReady: true,
  runnerRunning: false,
};

test("bot-less: ready on web + db alone, with no telegram block", () => {
  const snap = healthSnapshot({ ...baseState, botEnabled: false });
  assert.equal(snap.ready, true);
  // A pure-web deployment must not require — or even report — Telegram.
  assert.equal("telegram" in snap, false);
  assert.equal(snap.db.ready, true);
});

test("bot-less: telegram down/runner stopped does NOT affect readiness", () => {
  // Even with every Telegram signal false, a bot-off deployment is ready.
  const snap = healthSnapshot({
    ...baseState,
    botEnabled: false,
    telegramReady: false,
    runnerRunning: false,
  });
  assert.equal(snap.ready, true);
  assert.equal("telegram" in snap, false);
});

test("bot-less: not ready until db is ready", () => {
  const snap = healthSnapshot({
    ...baseState,
    botEnabled: false,
    dbReady: false,
  });
  assert.equal(snap.ready, false);
});

test("bot-less: not ready while the base ready flag is false", () => {
  // index.ts only flips `ready` after migrations + DB readiness complete.
  const snap = healthSnapshot({ ...baseState, botEnabled: false, ready: false });
  assert.equal(snap.ready, false);
});

test("bot-enabled: readiness additionally requires Telegram + a running runner", () => {
  // Reports the telegram block and is NOT ready until Telegram is reachable.
  const notReady = healthSnapshot({
    ...baseState,
    botEnabled: true,
    telegramReady: false,
    runnerRunning: false,
  });
  assert.equal(notReady.ready, false);
  assert.ok(notReady.telegram);
  assert.equal(notReady.telegram.ready, false);

  const ready = healthSnapshot({
    ...baseState,
    botEnabled: true,
    telegramReady: true,
    telegramUsername: "evisa_bot",
    runnerRunning: true,
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.telegram.ready, true);
  assert.equal(ready.telegram.username, "evisa_bot");
  assert.equal(ready.telegram.runnerRunning, true);
});

test("bot-enabled: a stopped runner drops readiness", () => {
  const snap = healthSnapshot({
    ...baseState,
    botEnabled: true,
    telegramReady: true,
    runnerRunning: false,
  });
  assert.equal(snap.ready, false);
});

test("shutting down is reflected regardless of bot mode", () => {
  for (const botEnabled of [false, true]) {
    const snap = healthSnapshot({
      ...baseState,
      botEnabled,
      telegramReady: true,
      runnerRunning: true,
      shuttingDown: true,
    });
    assert.equal(snap.shuttingDown, true);
  }
});
