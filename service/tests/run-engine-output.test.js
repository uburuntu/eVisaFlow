import assert from "node:assert/strict";
import test from "node:test";
import { decrypt } from "../dist/crypto/encryption.js";
import { resetQueueForTests, setConcurrency } from "../dist/runner/queue.js";
import { createInMemoryRunBus } from "../dist/runner/run-bus.js";
import { createRunEngine } from "../dist/runner/run-engine.js";
import { resetPendingForTests } from "../dist/runner/two-factor-store.js";

const SERVER_KEY_HEX = "11".repeat(32);
const flush = () => new Promise((resolve) => setImmediate(resolve));

function serverInput(runId, overrides = {}) {
  return {
    runId,
    ownerKey: `owner-${runId}`,
    custody: "server",
    trigger: "manual",
    headless: true,
    diagnosticsMode: "off",
    applicant: { kind: "memberRef", userId: "user-1", familyMemberId: "member-1" },
    ...overrides,
  };
}

function fakeResult(overrides = {}) {
  return {
    shareCode: "ABC123XYZ",
    validUntil: "2030-12-31",
    pdf: {
      kind: "bytes",
      bytes: new Uint8Array([1, 2, 3]),
      filename: "EVISA_Doe_Jane_2030-12-31.pdf",
      contentType: "application/pdf",
      byteLength: 3,
    },
    checker: {
      shareCode: "ABC123XYZ",
      html: {
        kind: "bytes",
        bytes: new Uint8Array([4, 5]),
        filename: "checker.html",
        contentType: "text/html",
        byteLength: 2,
        standalone: true,
      },
      pdf: {
        kind: "bytes",
        bytes: new Uint8Array([6, 7, 8, 9]),
        filename: "checker.pdf",
        contentType: "application/pdf",
        byteLength: 4,
      },
    },
    ...overrides,
  };
}

async function collect(iterable, predicate) {
  const events = [];
  for await (const event of iterable) {
    events.push(event);
    if (predicate?.(event, events)) break;
  }
  return events;
}

/** Records every db write so tests can assert mapping without a real DB. */
function makeDbRecorder() {
  const statusCalls = [];
  const eventCalls = [];
  return {
    db: { tag: "db" },
    statusCalls,
    eventCalls,
    updateRunStatus: async (_db, runId, update) => {
      statusCalls.push({ runId, update });
      return true;
    },
    insertRunEvent: async (_db, event) => {
      eventCalls.push(event);
    },
  };
}

// Server-custody output handling is driven purely by `input.custody`; tests use
// an inline applicant so the secret resolver passes through (no DB member
// lookup, no Playwright/EVisaClient construction) while the server output branch
// still runs.

test.beforeEach(() => {
  resetQueueForTests();
  resetPendingForTests();
  setConcurrency(2);
});

test("server custody: completed carries AES-sealed + unsealed share code, one artifact_ready per produced artifact", async () => {
  const bus = createInMemoryRunBus();
  const engine = createRunEngine({
    bus,
    serverKeyHex: SERVER_KEY_HEX,
    // Stub the secret resolver path by injecting an inline run so no DB member
    // lookup is needed; output handling is custody-driven by the input.
    runJob: async () => fakeResult(),
  });

  // Use an inline (client-shaped) applicant but force server custody so the
  // resolver passes through without touching the DB and output handling runs
  // the server branch.
  engine.enqueueRun(
    serverInput("run-out", {
      applicant: {
        kind: "inline",
        applicant: {
          identityDocument: { type: "passport", number: "P1" },
          dateOfBirth: "1990-01-01",
        },
        purpose: "right_to_work",
        twoFactorMethod: "sms",
        memberName: "Jane Doe",
      },
    })
  );

  const events = await collect(engine.subscribe("run-out"));
  const types = events.map((e) => e.type);
  // Artifacts are published before the terminal `completed` (which ends the
  // bus topic for all subscribers).
  assert.deepEqual(types, [
    "started",
    "artifact_ready",
    "artifact_ready",
    "artifact_ready",
    "completed",
  ]);

  const completed = events.find((e) => e.type === "completed");
  assert.equal(completed.shareCode, "ABC123XYZ");
  assert.equal(completed.validUntil, "2030-12-31");
  assert.equal(completed.sealedShareCode.alg, "aesgcm");
  assert.ok(completed.sealedShareCode.cipher, "sealed share code cipher present");
  // The cipher must actually decrypt back to the share code with the server key.
  assert.equal(decrypt(completed.sealedShareCode.cipher, SERVER_KEY_HEX), "ABC123XYZ");
  // Unsealed bytes are NOT present on the share code blob.
  assert.equal(completed.sealedShareCode.bytes, undefined);

  const artifacts = events.filter((e) => e.type === "artifact_ready");
  assert.deepEqual(
    artifacts.map((a) => a.artifact.kind),
    ["pdf", "checker_html", "checker_pdf"]
  );
  // Server custody carries unsealed bytes for the trusted bot.
  const pdf = artifacts[0].artifact;
  assert.equal(pdf.filename, "EVISA_Doe_Jane_2030-12-31.pdf");
  assert.equal(pdf.contentType, "application/pdf");
  assert.equal(pdf.byteLength, 3);
  assert.equal(pdf.sealed.alg, "aesgcm");
  assert.deepEqual(Array.from(pdf.sealed.bytes), [1, 2, 3]);
});

test("server custody: only byte-mode artifacts are forwarded", async () => {
  const bus = createInMemoryRunBus();
  const engine = createRunEngine({
    bus,
    serverKeyHex: SERVER_KEY_HEX,
    runJob: async () =>
      fakeResult({
        // No checker at all and the pdf is a file (not bytes) -> skipped.
        pdf: {
          kind: "file",
          path: "/tmp/x.pdf",
          filename: "x.pdf",
          contentType: "application/pdf",
        },
        checker: undefined,
      }),
  });

  engine.enqueueRun(
    serverInput("run-files", {
      applicant: {
        kind: "inline",
        applicant: {
          identityDocument: { type: "passport", number: "P1" },
          dateOfBirth: "1990-01-01",
        },
        purpose: "right_to_work",
        memberName: "Jane Doe",
      },
    })
  );

  const events = await collect(engine.subscribe("run-files"));
  assert.deepEqual(
    events.map((e) => e.type),
    ["started", "completed"]
  );
});

test("DB persistence subscriber maps lifecycle events to updateRunStatus + insertRunEvent", async () => {
  const recorder = makeDbRecorder();
  const bus = createInMemoryRunBus();
  const engine = createRunEngine({
    bus,
    serverKeyHex: SERVER_KEY_HEX,
    db: recorder.db,
    updateRunStatus: recorder.updateRunStatus,
    insertRunEvent: recorder.insertRunEvent,
    runJob: async ({ publish }) => {
      // Drive a representative lifecycle including a 2FA gate and a phase.
      publish({ type: "challenge_required", method: "sms", deadlineMs: 123 });
      publish({ type: "phase", phase: "creating_share_code", label: "Creating" });
      return fakeResult();
    },
  });

  engine.enqueueRun(
    serverInput("run-db", {
      applicant: {
        kind: "inline",
        applicant: {
          identityDocument: { type: "passport", number: "P1" },
          dateOfBirth: "1990-01-01",
        },
        purpose: "right_to_work",
        twoFactorMethod: "sms",
        memberName: "Jane Doe",
      },
    })
  );

  await collect(engine.subscribe("run-db"));
  // Allow the internal persistence subscriber (async) to drain.
  await flush();
  await flush();

  // Status transitions: running -> awaiting_2fa -> success.
  const statuses = recorder.statusCalls.map((c) => c.update.status);
  assert.deepEqual(statuses, ["running", "awaiting_2fa", "success"]);

  const success = recorder.statusCalls.find((c) => c.update.status === "success");
  assert.equal(success.runId, "run-db");
  assert.equal(success.update.valid_until, "2030-12-31");
  // The persisted share code is the AES ciphertext, never the plaintext.
  assert.ok(success.update.encrypted_share_code);
  assert.notEqual(success.update.encrypted_share_code, "ABC123XYZ");
  assert.equal(decrypt(success.update.encrypted_share_code, SERVER_KEY_HEX), "ABC123XYZ");

  // Every event is mirrored to the run_events timeline.
  const eventTypes = recorder.eventCalls.map((e) => e.event_type);
  assert.ok(eventTypes.includes("started"));
  assert.ok(eventTypes.includes("challenge_required"));
  assert.ok(eventTypes.includes("phase"));
  assert.ok(eventTypes.includes("completed"));
  assert.ok(eventTypes.includes("artifact_ready"));
  for (const ev of recorder.eventCalls) {
    assert.equal(ev.run_id, "run-db");
  }
});

test("DB persistence subscriber records failures with code + message", async () => {
  const recorder = makeDbRecorder();
  const bus = createInMemoryRunBus();
  const engine = createRunEngine({
    bus,
    serverKeyHex: SERVER_KEY_HEX,
    db: recorder.db,
    updateRunStatus: recorder.updateRunStatus,
    insertRunEvent: recorder.insertRunEvent,
    runJob: async ({ publish }) => {
      publish({
        type: "failed",
        code: "AUTHENTICATION_FAILED",
        message: "GOV.UK rejected the details",
        terminal: true,
      });
      return undefined;
    },
  });

  engine.enqueueRun(
    serverInput("run-fail", {
      applicant: {
        kind: "inline",
        applicant: {
          identityDocument: { type: "passport", number: "P1" },
          dateOfBirth: "1990-01-01",
        },
        purpose: "right_to_work",
        memberName: "Jane Doe",
      },
    })
  );

  await collect(engine.subscribe("run-fail"));
  await flush();
  await flush();

  const failed = recorder.statusCalls.find((c) => c.update.status === "failed");
  assert.ok(failed, "a failed status transition is persisted");
  assert.equal(failed.update.error_code, "AUTHENTICATION_FAILED");
  assert.equal(failed.update.error_message, "GOV.UK rejected the details");
  // After a terminal failed event the run is over: no success transition.
  assert.ok(!recorder.statusCalls.some((c) => c.update.status === "success"));
});

test("persistence failures are swallowed and never break the live run", async () => {
  let calls = 0;
  const bus = createInMemoryRunBus();
  const engine = createRunEngine({
    bus,
    serverKeyHex: SERVER_KEY_HEX,
    db: { tag: "db" },
    updateRunStatus: async () => {
      calls += 1;
      throw new Error("db down");
    },
    insertRunEvent: async () => {
      throw new Error("db down");
    },
    runJob: async () => fakeResult({ checker: undefined }),
  });

  engine.enqueueRun(
    serverInput("run-dbfail", {
      applicant: {
        kind: "inline",
        applicant: {
          identityDocument: { type: "passport", number: "P1" },
          dateOfBirth: "1990-01-01",
        },
        purpose: "right_to_work",
        memberName: "Jane Doe",
      },
    })
  );

  // The live stream still completes despite db errors.
  const events = await collect(engine.subscribe("run-dbfail"));
  assert.equal(events.at(-1).type, "completed");
  await flush();
  assert.ok(calls > 0, "persistence was attempted");
});

test("client custody output handling is not implemented yet (Phase 3) -> run fails terminally", async () => {
  const bus = createInMemoryRunBus();
  const engine = createRunEngine({
    bus,
    runJob: async () => fakeResult(),
  });

  engine.enqueueRun({
    runId: "run-client",
    ownerKey: "owner-client",
    custody: "client",
    recipientPublicKey: new Uint8Array([1, 2, 3]),
    trigger: "manual",
    headless: true,
    diagnosticsMode: "off",
    applicant: {
      kind: "inline",
      applicant: {
        identityDocument: { type: "passport", number: "P1" },
        dateOfBirth: "1990-01-01",
      },
      purpose: "right_to_work",
      memberName: "Private User",
    },
  });

  const events = await collect(engine.subscribe("run-client"));
  const failure = events.find((e) => e.type === "failed");
  assert.ok(failure, "client custody output sealing should fail until Phase 3");
  assert.match(failure.message, /not implemented/i);
  // No completed event leaked for an unsealed client-custody run.
  assert.ok(!events.some((e) => e.type === "completed"));
});
