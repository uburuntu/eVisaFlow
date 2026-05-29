import assert from "node:assert/strict";
import test from "node:test";
import { resetQueueForTests, setConcurrency } from "../dist/runner/queue.js";
import { createInMemoryRunBus } from "../dist/runner/run-bus.js";
import { createRunEngine, translateEVisaEvent } from "../dist/runner/run-engine.js";
import { requestCode, resetPendingForTests } from "../dist/runner/two-factor-store.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function inlineInput(runId, overrides = {}) {
  return {
    runId,
    ownerKey: `owner-${runId}`,
    custody: "client",
    recipientPublicKey: new Uint8Array([1, 2, 3]),
    trigger: "manual",
    headless: true,
    diagnosticsMode: "off",
    applicant: {
      kind: "inline",
      applicant: {
        identityDocument: { type: "passport", number: "P-INLINE" },
        dateOfBirth: "1990-01-01",
      },
      purpose: "right_to_work",
      twoFactorMethod: "sms",
      memberName: "Inline User",
    },
    ...overrides,
  };
}

async function collect(iterable, predicate) {
  const events = [];
  for await (const event of iterable) {
    events.push(event);
    if (predicate?.(event, events)) {
      break;
    }
  }
  return events;
}

test.beforeEach(() => {
  resetQueueForTests();
  resetPendingForTests();
  setConcurrency(2);
});

test("subscribe replays backlog then streams live events to completion", async () => {
  const bus = createInMemoryRunBus();
  const engine = createRunEngine({
    bus,
    runJob: async ({ publish }) => {
      publish({ type: "phase", phase: "launching", label: "Launching" });
      publish({ type: "phase", phase: "creating_share_code", label: "Creating" });
      publish({
        type: "completed",
        validUntil: "2030-01-01",
        sealedShareCode: { alg: "box_seal", bytes: new Uint8Array([7, 7]) },
      });
    },
  });

  const result = engine.enqueueRun(inlineInput("run-a"));
  assert.equal(result.accepted, true);

  const events = await collect(engine.subscribe("run-a"));
  const types = events.map((e) => e.type);
  // Engine publishes `started`, the job publishes phases + completed.
  assert.deepEqual(types, ["started", "phase", "phase", "completed"]);
  const completed = events.at(-1);
  assert.equal(completed.validUntil, "2030-01-01");
  assert.equal(completed.sealedShareCode.alg, "box_seal");
});

test("submitCode resolves a 2FA gate so the run proceeds to completion", async () => {
  const bus = createInMemoryRunBus();
  const engine = createRunEngine({
    bus,
    runJob: async ({ input, publish }) => {
      const deadlineMs = Date.now() + 1_000;
      // Wire the gate through the real two-factor-store so submitCode resolves it.
      const codePromise = requestCode({
        requestId: input.runId,
        method: "sms",
        memberName: "Inline User",
        deadlineMs,
      });
      publish({ type: "challenge_required", method: "sms", deadlineMs });
      const code = await codePromise;
      publish({ type: "phase", phase: "viewing_status", label: `code:${code}` });
      publish({
        type: "completed",
        sealedShareCode: { alg: "box_seal", bytes: new Uint8Array([1]) },
      });
    },
  });

  engine.enqueueRun(inlineInput("run-2fa"));

  const seen = [];
  const iterator = engine.subscribe("run-2fa")[Symbol.asyncIterator]();

  // Pull until the challenge appears.
  let event;
  do {
    ({ value: event } = await iterator.next());
    seen.push(event);
  } while (event && event.type !== "challenge_required");
  assert.equal(event.type, "challenge_required");

  // Submitting an unknown run id does nothing.
  assert.equal(engine.submitCode("nope", "000000"), false);
  // The correct run id resolves the gate.
  assert.equal(engine.submitCode("run-2fa", "123456"), true);

  // Continue draining to completion.
  let done = false;
  while (!done) {
    const next = await iterator.next();
    if (next.done) {
      done = true;
      break;
    }
    seen.push(next.value);
  }

  const phaseAfterCode = seen.find(
    (e) => e.type === "phase" && e.label === "code:123456"
  );
  assert.ok(phaseAfterCode, "phase carrying the submitted code should be published");
  assert.equal(seen.at(-1).type, "completed");
});

test("cancel aborts an in-flight run and the stream ends with failure", async () => {
  const bus = createInMemoryRunBus();
  let observedAbort = false;
  const engine = createRunEngine({
    bus,
    runJob: async ({ signal, publish }) => {
      publish({ type: "phase", phase: "launching", label: "Launching" });
      await new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
          },
          { once: true }
        );
      });
    },
  });

  engine.enqueueRun(inlineInput("run-cancel"));
  await flush();
  await flush();

  assert.equal(engine.cancel("run-cancel", "User cancelled"), true);

  const events = await collect(engine.subscribe("run-cancel"));
  assert.equal(observedAbort, true);
  const failure = events.find((e) => e.type === "failed");
  assert.ok(failure, "a terminal failed event should be published on cancel");
  assert.equal(failure.terminal, true);
  // The terminal event must carry the cancellation code (so the bot renders
  // "Cancelled for ..." not the generic error) and the `cancelled` cause (so
  // persistence records the run as cancelled, never failed).
  assert.equal(failure.code, "CANCELLED");
  assert.equal(failure.cause, "cancelled");
  // cancel on an unknown / finished run returns false.
  assert.equal(engine.cancel("run-cancel"), false);
});

test("cancel while still queued publishes a CANCELLED terminal event", async () => {
  setConcurrency(1);
  const bus = createInMemoryRunBus();
  let releaseFirst;
  const engine = createRunEngine({
    bus,
    runJob: async ({ input }) => {
      if (input.runId === "run-busy") {
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
    },
  });

  // Same ownerKey forces the second run to wait (queued, never started).
  const owner = "shared-owner";
  engine.enqueueRun(inlineInput("run-busy", { ownerKey: owner }));
  await flush();
  engine.enqueueRun(inlineInput("run-queued", { ownerKey: owner }));
  await flush();

  // Cancel the waiting run before it ever runs: the queue rejects its handle and
  // the engine's catch must still surface CANCELLED (not UNKNOWN).
  assert.equal(engine.cancel("run-queued", "User cancelled"), true);

  const events = await collect(engine.subscribe("run-queued"));
  const failure = events.find((e) => e.type === "failed");
  assert.ok(failure, "a terminal failed event should be published on cancel");
  assert.equal(failure.code, "CANCELLED");
  assert.equal(failure.cause, "cancelled");

  releaseFirst?.();
});

test("a terminal event closes the topic after the grace window", async () => {
  const bus = createInMemoryRunBus({ terminalGraceMs: 20 });
  const engine = createRunEngine({
    bus,
    runJob: async ({ publish }) => {
      publish({
        type: "completed",
        sealedShareCode: { alg: "box_seal", bytes: new Uint8Array([2]) },
      });
    },
  });

  engine.enqueueRun(inlineInput("run-teardown"));
  await collect(engine.subscribe("run-teardown"));

  assert.ok(engine.getSnapshot("run-teardown"));
  assert.equal(engine.getSnapshot("run-teardown").status, "completed");

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(engine.getSnapshot("run-teardown"), undefined);
});

test("duplicate enqueue for the same run is rejected", async () => {
  const bus = createInMemoryRunBus();
  let release;
  const engine = createRunEngine({
    bus,
    runJob: async () => {
      await new Promise((resolve) => {
        release = resolve;
      });
    },
  });

  const first = engine.enqueueRun(inlineInput("run-dup"));
  assert.equal(first.accepted, true);
  await flush();

  const second = engine.enqueueRun(inlineInput("run-dup"));
  assert.equal(second.accepted, false);
  assert.equal(second.reason, "duplicate");

  release?.();
});

test("getSnapshot reflects queued position while a slot is busy", async () => {
  setConcurrency(1);
  const bus = createInMemoryRunBus();
  let releaseFirst;
  const engine = createRunEngine({
    bus,
    runJob: async ({ input }) => {
      if (input.runId === "run-busy") {
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
    },
  });

  // Same ownerKey so the second run is forced to wait behind the first.
  const owner = "shared-owner";
  engine.enqueueRun(inlineInput("run-busy", { ownerKey: owner }));
  await flush();
  engine.enqueueRun(inlineInput("run-waiting", { ownerKey: owner }));
  await flush();

  const snapshot = engine.getSnapshot("run-waiting");
  assert.ok(snapshot);
  assert.equal(snapshot.status, "queued");
  assert.ok((snapshot.position ?? 0) >= 1);

  releaseFirst?.();
});

test("translateEVisaEvent maps the core event union to RunEvents", () => {
  assert.deepEqual(translateEVisaEvent({ type: "run_started", phase: "launching" }), {
    type: "started",
  });
  assert.deepEqual(
    translateEVisaEvent({ type: "phase_changed", phase: "creating_share_code" }),
    { type: "phase", phase: "creating_share_code", label: "Creating share code" }
  );
  assert.deepEqual(
    translateEVisaEvent({
      type: "challenge_required",
      phase: "waiting_for_2fa",
      challenge: { type: "security_code", deliveryMethod: "email", deadlineMs: 999 },
    }),
    { type: "challenge_required", method: "email", deadlineMs: 999 }
  );
  assert.deepEqual(
    translateEVisaEvent({
      type: "failed",
      phase: "failed",
      error: { name: "EVisaError", message: "x", code: "AUTHENTICATION_FAILED" },
    }),
    {
      type: "failed",
      code: "AUTHENTICATION_FAILED",
      message: "x",
      terminal: true,
    }
  );
  // completed is intentionally not forwarded raw (sealing happens in the job).
  assert.equal(
    translateEVisaEvent({
      type: "completed",
      phase: "completed",
      result: { shareCode: "ABC" },
    }),
    undefined
  );
});
