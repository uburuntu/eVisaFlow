import assert from "node:assert/strict";
import test from "node:test";
import { createEvisaRunJob } from "../dist/runner/evisa-run-job.js";
import { resetPendingForTests, resolveCode } from "../dist/runner/two-factor-store.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeContext(overrides = {}) {
  const published = [];
  return {
    published,
    ctx: {
      input: {
        runId: "run-1",
        ownerKey: "owner-1",
        custody: "server",
        trigger: "manual",
        headless: true,
        diagnosticsMode: "off",
        applicant: { kind: "memberRef", userId: "u", familyMemberId: "m" },
      },
      applicant: {
        identityDocument: { type: "passport", number: "P-INLINE" },
        dateOfBirth: "1990-01-01",
      },
      purpose: "right_to_work",
      twoFactorMethod: "sms",
      memberName: "Jane Doe",
      signal: new AbortController().signal,
      publish: (event) => published.push(event),
      log: { child: () => ({}) },
      ...overrides,
    },
  };
}

function fakeResult() {
  return {
    shareCode: "ABC123",
    validUntil: "2030-01-01",
    pdf: {
      kind: "bytes",
      bytes: new Uint8Array([1]),
      filename: "evisa.pdf",
      contentType: "application/pdf",
      byteLength: 1,
    },
  };
}

test.beforeEach(() => {
  resetPendingForTests();
});

test("run-job forwards translated core events and the 2FA challenge, returns the result", async () => {
  let capturedOptions;
  let capturedRequest;

  const job = createEvisaRunJob({
    createClient: (options) => {
      capturedOptions = options;
      return {
        createShareCode: async (request) => {
          capturedRequest = request;
          // Emit a representative set of core EVisaEvents through onEvent.
          options.onEvent?.({ type: "run_started", phase: "launching" });
          options.onEvent?.({ type: "phase_changed", phase: "creating_share_code" });
          options.onEvent?.({
            type: "timing",
            phase: "creating_share_code",
            operation: "step",
            durationMs: 42,
            stepId: "summary",
          });
          // `completed` must NOT be forwarded by the translator (engine seals it).
          options.onEvent?.({
            type: "completed",
            phase: "completed",
            result: { shareCode: "ABC123" },
          });

          // Drive the human-2FA gate and resolve it via the two-factor store.
          const challengePromise = request.onChallenge(
            {
              type: "security_code",
              deliveryMethod: "sms",
              deadlineMs: Date.now() + 1000,
            },
            { deadlineMs: Date.now() + 1000, signal: request.signal }
          );
          // The job should have registered a pending request keyed by runId.
          await flush();
          assert.equal(resolveCode("run-1", "654321"), true);
          const challengeResponse = await challengePromise;
          assert.deepEqual(challengeResponse, { code: "654321" });

          return fakeResult();
        },
      };
    },
  });

  const { ctx, published } = makeContext();
  const result = await job(ctx);

  // The client was built with bytes-mode artifacts + the input's diagnostics/headless.
  assert.equal(capturedOptions.browser.headless, true);
  assert.equal(capturedOptions.artifacts.pdf.mode, "bytes");
  assert.equal(capturedOptions.artifacts.checker.html.mode, "bytes");
  assert.equal(capturedOptions.artifacts.checker.pdf.mode, "bytes");
  assert.equal(capturedOptions.artifacts.diagnostics.mode, "off");

  // createShareCode received the context's applicant/purpose/2fa/signal.
  assert.deepEqual(capturedRequest.applicant, ctx.applicant);
  assert.equal(capturedRequest.purpose, "right_to_work");
  assert.equal(capturedRequest.challengePreference.deliveryMethod, "sms");
  assert.equal(capturedRequest.signal, ctx.signal);

  // Published RunEvents: started + phase + timing + challenge_required.
  // (run_started -> started, phase_changed -> phase, timing -> timing,
  //  completed -> dropped, plus the explicit challenge_required from onChallenge.)
  const types = published.map((e) => e.type);
  assert.deepEqual(types, ["started", "phase", "timing", "challenge_required"]);

  const phase = published.find((e) => e.type === "phase");
  assert.deepEqual(phase, {
    type: "phase",
    phase: "creating_share_code",
    label: "Creating share code",
  });
  const timing = published.find((e) => e.type === "timing");
  assert.equal(timing.operation, "step");
  assert.equal(timing.durationMs, 42);
  assert.equal(timing.stepId, "summary");
  const challenge = published.find((e) => e.type === "challenge_required");
  assert.equal(challenge.method, "sms");

  // The result bubbles straight back (engine does sealing/persistence).
  assert.equal(result, await Promise.resolve(result));
  assert.deepEqual(result, fakeResult());
});

test("run-job passes diagnosticsMode and headless from the input through to the client", async () => {
  let capturedOptions;
  const job = createEvisaRunJob({
    createClient: (options) => {
      capturedOptions = options;
      return { createShareCode: async () => fakeResult() };
    },
  });

  const { ctx } = makeContext({
    input: {
      runId: "run-2",
      ownerKey: "owner-2",
      custody: "server",
      trigger: "scheduled",
      headless: false,
      diagnosticsMode: "sanitized_on_failure",
      applicant: { kind: "memberRef", userId: "u", familyMemberId: "m" },
    },
  });
  await job(ctx);

  assert.equal(capturedOptions.browser.headless, false);
  assert.equal(capturedOptions.artifacts.diagnostics.mode, "sanitized_on_failure");
});

test("run-job 2FA gate uses an injectable requestCode keyed by runId only", async () => {
  let requestCodeArgs;
  const job = createEvisaRunJob({
    requestCode: async (options) => {
      requestCodeArgs = options;
      return "111222";
    },
    createClient: () => ({
      createShareCode: async (request) => {
        const response = await request.onChallenge(
          { type: "security_code", deliveryMethod: "email", deadlineMs: 5000 },
          { deadlineMs: 5000, signal: request.signal }
        );
        assert.deepEqual(response, { code: "111222" });
        return fakeResult();
      },
    }),
  });

  const { ctx, published } = makeContext({ twoFactorMethod: "email" });
  await job(ctx);

  // requestCode is keyed by runId and carries the member name + deadline, but
  // NOT telegramId/chatId (those Telegram-only fields stay absent for web).
  assert.equal(requestCodeArgs.requestId, "run-1");
  assert.equal(requestCodeArgs.method, "email");
  assert.equal(requestCodeArgs.memberName, "Jane Doe");
  assert.equal(requestCodeArgs.deadlineMs, 5000);
  assert.equal(requestCodeArgs.telegramId, undefined);
  assert.equal(requestCodeArgs.chatId, undefined);

  const challenge = published.find((e) => e.type === "challenge_required");
  assert.equal(challenge.method, "email");
  assert.equal(challenge.deadlineMs, 5000);
});

test("run-job propagates createShareCode failures", async () => {
  const job = createEvisaRunJob({
    createClient: () => ({
      createShareCode: async () => {
        throw new Error("GOV.UK is unavailable");
      },
    }),
  });
  const { ctx } = makeContext();
  await assert.rejects(job(ctx), /GOV\.UK is unavailable/);
});
