import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryRunBus } from "../dist/runner/run-bus.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Drain an async iterable to completion (terminal events end the stream). */
async function drain(iterable) {
  const events = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

test("fans out live events to multiple subscribers", async () => {
  const bus = createInMemoryRunBus();
  const a = drain(bus.subscribe("run-1"));
  const b = drain(bus.subscribe("run-1"));
  await flush();

  bus.publish("run-1", { type: "started" });
  bus.publish("run-1", { type: "phase", phase: "launching", label: "Launching" });
  bus.publish("run-1", {
    type: "completed",
    sealedShareCode: { alg: "box_seal", bytes: new Uint8Array([1]) },
  });

  const [aEvents, bEvents] = await Promise.all([a, b]);
  assert.deepEqual(
    aEvents.map((e) => e.type),
    ["started", "phase", "completed"]
  );
  assert.deepEqual(
    bEvents.map((e) => e.type),
    ["started", "phase", "completed"]
  );
});

test("replays the backlog for a late-joining subscriber, then tails live", async () => {
  const bus = createInMemoryRunBus();
  bus.publish("run-2", { type: "started" });
  bus.publish("run-2", {
    type: "phase",
    phase: "verifying_identity",
    label: "Verifying",
  });

  // Subscribe AFTER two events were already published.
  const lateEvents = [];
  const iterator = bus.subscribe("run-2")[Symbol.asyncIterator]();

  // Backlog must be replayed first.
  const first = await iterator.next();
  const second = await iterator.next();
  assert.equal(first.value.type, "started");
  assert.equal(second.value.type, "phase");

  // Now tail a live event.
  const livePromise = iterator.next();
  bus.publish("run-2", {
    type: "challenge_required",
    method: "sms",
    deadlineMs: Date.now() + 1000,
  });
  const live = await livePromise;
  assert.equal(live.value.type, "challenge_required");

  lateEvents.push(first.value, second.value, live.value);
  assert.equal(lateEvents.length, 3);
});

test("a late subscriber after a terminal event replays then ends", async () => {
  const bus = createInMemoryRunBus();
  bus.publish("run-3", { type: "started" });
  bus.publish("run-3", {
    type: "failed",
    code: "AUTHENTICATION_FAILED",
    message: "bad creds",
    terminal: true,
  });

  // Join after the terminal event: should replay backlog then end the stream.
  const events = await drain(bus.subscribe("run-3"));
  assert.deepEqual(
    events.map((e) => e.type),
    ["started", "failed"]
  );
});

test("terminal event flushes existing subscribers and ends their streams", async () => {
  const bus = createInMemoryRunBus();
  const collected = drain(bus.subscribe("run-4"));
  await flush();

  bus.publish("run-4", { type: "started" });
  bus.publish("run-4", {
    type: "completed",
    validUntil: "2030-01-01",
    sealedShareCode: { alg: "aesgcm", cipher: "x:y:z" },
  });

  // drain() only resolves if the stream actually ends after the terminal event.
  const events = await collected;
  assert.deepEqual(
    events.map((e) => e.type),
    ["started", "completed"]
  );
});

test("ignores events published after a terminal event", async () => {
  const bus = createInMemoryRunBus();
  bus.publish("run-5", { type: "started" });
  bus.publish("run-5", {
    type: "failed",
    code: "FLOW_FAILED",
    message: "boom",
    terminal: true,
  });
  // This must be dropped.
  bus.publish("run-5", { type: "phase", phase: "launching", label: "Launching" });

  const events = await drain(bus.subscribe("run-5"));
  assert.deepEqual(
    events.map((e) => e.type),
    ["started", "failed"]
  );
});

test("schedules topic teardown after the terminal grace window", async () => {
  const bus = createInMemoryRunBus({ terminalGraceMs: 20 });
  bus.publish("run-6", { type: "started" });
  bus.publish("run-6", {
    type: "completed",
    sealedShareCode: { alg: "box_seal", bytes: new Uint8Array([9]) },
  });

  // Snapshot still available during the grace window.
  assert.ok(bus.snapshot("run-6"));
  assert.equal(bus.snapshot("run-6").status, "completed");

  await new Promise((resolve) => setTimeout(resolve, 40));

  // After the grace window the topic is torn down.
  assert.equal(bus.snapshot("run-6"), undefined);
});

test("snapshot derives status, phase, and challenge fields from events", async () => {
  const bus = createInMemoryRunBus();
  bus.publish("run-7", { type: "queued", position: 3, active: 2 });
  assert.deepEqual(bus.snapshot("run-7"), {
    runId: "run-7",
    status: "queued",
    position: 3,
    active: 2,
    lastEvent: { type: "queued", position: 3, active: 2 },
  });

  bus.publish("run-7", { type: "started" });
  assert.equal(bus.snapshot("run-7").status, "running");
  assert.equal(bus.snapshot("run-7").position, 0);

  bus.publish("run-7", {
    type: "phase",
    phase: "creating_share_code",
    label: "Creating",
  });
  assert.equal(bus.snapshot("run-7").phase, "creating_share_code");
  assert.equal(bus.snapshot("run-7").phaseLabel, "Creating");

  bus.publish("run-7", {
    type: "challenge_required",
    method: "email",
    deadlineMs: 12345,
  });
  assert.equal(bus.snapshot("run-7").status, "awaiting_2fa");
  assert.equal(bus.snapshot("run-7").challengeMethod, "email");
  assert.equal(bus.snapshot("run-7").challengeDeadlineMs, 12345);
});

test("close() ends live subscribers and drops the topic immediately", async () => {
  const bus = createInMemoryRunBus();
  const collected = drain(bus.subscribe("run-8"));
  await flush();
  bus.publish("run-8", { type: "started" });

  bus.close("run-8");
  const events = await collected;
  assert.deepEqual(
    events.map((e) => e.type),
    ["started"]
  );
  assert.equal(bus.snapshot("run-8"), undefined);
});

test("early consumer return() unsubscribes without affecting other subscribers", async () => {
  const bus = createInMemoryRunBus();
  const iterA = bus.subscribe("run-9")[Symbol.asyncIterator]();
  const b = drain(bus.subscribe("run-9"));
  await flush();

  bus.publish("run-9", { type: "started" });
  const firstA = await iterA.next();
  assert.equal(firstA.value.type, "started");

  // A bails out early.
  await iterA.return();

  // B keeps receiving and the stream still terminates correctly.
  bus.publish("run-9", {
    type: "completed",
    sealedShareCode: { alg: "box_seal", bytes: new Uint8Array([1]) },
  });
  const bEvents = await b;
  assert.deepEqual(
    bEvents.map((e) => e.type),
    ["started", "completed"]
  );
});
