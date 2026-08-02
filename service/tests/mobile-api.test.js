import assert from "node:assert/strict";
import test from "node:test";
import { buildMobileApi } from "../dist/api/app.js";

const userId = "9591fc30-b78f-4282-8fc9-ae662d725ad1";
const profileId = "1f8f9e99-f0ea-4591-a745-aabf871febc1";
const runId = "c6d85ab7-22cd-4ef7-a394-e82c0fd8226b";
const now = "2026-08-01T09:00:00.000Z";
const claimToken = "c".repeat(43);
const manifestHash = "d".repeat(64);
const artifactId = "1df5b293-76a3-4a95-994b-8c98cc9fa260";

const claimSession = {
  claimToken,
  claimExpiresAt: "2026-08-01T09:10:00.000Z",
  manifestHash,
  shareCode: "ABC 123 XYZ",
  validUntil: "2026-10-30",
  generatedAt: now,
  artifacts: [
    {
      id: artifactId,
      kind: "evisa_pdf",
      filename: "Fictional proof.pdf",
      contentType: "application/pdf",
      byteLength: 4,
      sha256: "a".repeat(64),
    },
  ],
};

const runRequest = {
  clientRunId: runId,
  profileId,
  applicant: {
    identityDocument: { type: "passport", number: "123456789" },
    dateOfBirth: "1980-03-31",
  },
  purpose: "right_to_work",
  preferredTwoFactorMethod: "sms",
  authorityBasis: "self",
  attestedAt: now,
  termsVersion: "2026-08-01",
};

function createFixture(options = {}) {
  const runs = new Map();
  const started = [];
  const cancelled = [];
  const slots = new Set();
  const beginClaimCalls = [];
  const acknowledgementCalls = [];
  const artifactCalls = [];
  let deletedAccountId = null;
  const store = {
    async getMe(ownerId) {
      return {
        userId: ownerId,
        entitlement: "free",
        profileLimit: 1,
        activeProfileCount: slots.size,
        successfulRunCount: 0,
        remainingFreeRuns: 3,
        serviceStatus: "available",
      };
    },
    async upsertProfileSlot(_ownerId, id) {
      slots.add(id);
    },
    async getActiveRunIds(ownerId) {
      return ownerId === userId
        ? Array.from(runs.values())
            .filter((run) =>
              ["queued", "running", "awaiting_2fa", "packaging"].includes(run.status)
            )
            .map((run) => run.id)
        : [];
    },
    async deleteAccount(ownerId) {
      deletedAccountId = ownerId;
      runs.clear();
      slots.clear();
    },
    async deleteProfileSlot(_ownerId, id) {
      slots.delete(id);
    },
    async createRun(_ownerId, request) {
      if (options.createRunError) throw options.createRunError;
      const run = {
        id: request.clientRunId,
        clientRunId: request.clientRunId,
        profileId: request.profileId,
        purpose: request.purpose,
        status: "queued",
        phase: "launching",
        createdAt: now,
        updatedAt: now,
      };
      runs.set(run.id, run);
      return run;
    },
    async getRun(ownerId, id) {
      return ownerId === userId ? (runs.get(id) ?? null) : null;
    },
    async getEvents(_ownerId, _runId, afterId) {
      return (options.events ?? []).filter((event) => event.id > afterId);
    },
    async updateRun(id, update) {
      runs.set(id, { ...runs.get(id), ...update });
    },
    async beginClaim(ownerId, id) {
      beginClaimCalls.push({ ownerId, id });
      return options.claimSession ?? null;
    },
    async acknowledgeClaim(ownerId, id, body) {
      acknowledgementCalls.push({ ownerId, id, body });
      return options.acknowledgement ?? null;
    },
    async downloadArtifact(ownerId, id, requestedArtifactId, token) {
      artifactCalls.push({ ownerId, id, requestedArtifactId, token });
      return options.artifact ?? null;
    },
  };
  const coordinator = {
    start(ownerId, request) {
      if (options.startError) throw options.startError;
      started.push({ ownerId, request });
    },
    submitChallenge() {
      return false;
    },
    cancel(ownerId, id) {
      cancelled.push({ ownerId, id });
      return true;
    },
  };
  const auth = {
    async getUserId(token) {
      return token === "valid-token" ? userId : null;
    },
  };
  const app = buildMobileApi({
    auth,
    coordinator,
    store,
    log: { error() {} },
  });
  return {
    app,
    runs,
    slots,
    started,
    cancelled,
    beginClaimCalls,
    acknowledgementCalls,
    artifactCalls,
    deletedAccountId: () => deletedAccountId,
  };
}

const authorized = (options) => ({
  ...options,
  headers: { authorization: "Bearer valid-token", ...options.headers },
});

test("mobile API rejects missing and invalid bearer sessions", async () => {
  const { app } = createFixture();
  const missing = await app.inject({ method: "GET", url: "/v1/me" });
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.json().code, "AUTH_REQUIRED");

  const invalid = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: "Bearer invalid" },
  });
  assert.equal(invalid.statusCode, 401);
  assert.equal(invalid.json().code, "AUTH_INVALID");
  await app.close();
});

test("mobile API prevents authenticated responses from being cached or embedded", async () => {
  const { app } = createFixture();
  const response = await app.inject(authorized({ method: "GET", url: "/v1/me" }));
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  await app.close();
});

test("mobile API synchronizes an opaque profile slot", async () => {
  const { app, slots } = createFixture();
  const put = await app.inject(
    authorized({
      method: "PUT",
      url: `/v1/profile-slots/${profileId}`,
      payload: { profileId },
    })
  );
  assert.equal(put.statusCode, 204);
  assert.equal(slots.has(profileId), true);

  const me = await app.inject(authorized({ method: "GET", url: "/v1/me" }));
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().activeProfileCount, 1);
  await app.close();
});

test("mobile API creates idempotent runs and starts the worker once", async () => {
  const { app, started } = createFixture();
  const first = await app.inject(
    authorized({ method: "POST", url: "/v1/runs", payload: runRequest })
  );
  assert.equal(first.statusCode, 202);
  assert.equal(first.json().id, runId);
  assert.equal(started.length, 1);

  const second = await app.inject(
    authorized({ method: "POST", url: "/v1/runs", payload: runRequest })
  );
  assert.equal(second.statusCode, 200);
  assert.equal(started.length, 1);
  await app.close();
});

test("mobile API interrupts and clears a run when queue startup fails", async () => {
  const { app, runs } = createFixture({ startError: new Error("queue unavailable") });
  const response = await app.inject(
    authorized({ method: "POST", url: "/v1/runs", payload: runRequest })
  );
  assert.equal(response.statusCode, 500);
  assert.deepEqual(
    {
      status: runs.get(runId).status,
      phase: runs.get(runId).phase,
      errorCode: runs.get(runId).errorCode,
      clearRequest: runs.get(runId).clearRequest,
    },
    {
      status: "interrupted",
      phase: "failed",
      errorCode: "QUEUE_START_FAILED",
      clearRequest: true,
    }
  );
  await app.close();
});

test("mobile API cancels active work before deleting the anonymous account", async () => {
  const { app, cancelled, deletedAccountId } = createFixture();
  const created = await app.inject(
    authorized({ method: "POST", url: "/v1/runs", payload: runRequest })
  );
  assert.equal(created.statusCode, 202);

  const response = await app.inject(authorized({ method: "DELETE", url: "/v1/me" }));
  assert.equal(response.statusCode, 204);
  assert.deepEqual(cancelled, [{ ownerId: userId, id: runId }]);
  assert.equal(deletedAccountId(), userId);
  await app.close();
});

test("mobile API rejects invalid run payloads before reaching the worker", async () => {
  const { app, started } = createFixture();
  const response = await app.inject(
    authorized({
      method: "POST",
      url: "/v1/runs",
      payload: {
        ...runRequest,
        applicant: { ...runRequest.applicant, dateOfBirth: "nope" },
      },
    })
  );
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, "REQUEST_INVALID");
  assert.equal(started.length, 0);
  await app.close();
});

test("mobile API rate limits repeated security-code submissions", async () => {
  const { app } = createFixture();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await app.inject(
      authorized({
        method: "POST",
        url: `/v1/runs/${runId}/challenge`,
        payload: { code: "123456" },
      })
    );
    assert.equal(response.statusCode, 404);
  }

  const limited = await app.inject(
    authorized({
      method: "POST",
      url: `/v1/runs/${runId}/challenge`,
      payload: { code: "123456" },
    })
  );
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().code, "RATE_LIMITED");
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  await app.close();
});

test("mobile API exposes the private-beta daily cap with an official fallback", async () => {
  const { app } = createFixture({ createRunError: new Error("BETA_DAILY_LIMIT") });
  const response = await app.inject(
    authorized({ method: "POST", url: "/v1/runs", payload: runRequest })
  );

  assert.equal(response.statusCode, 429);
  assert.equal(response.json().code, "BETA_DAILY_LIMIT");
  assert.equal(response.json().retryable, true);
  assert.match(response.json().message, /official GOV\.UK service/);
  assert.ok(Number(response.headers["retry-after"]) > 0);
  await app.close();
});

test("mobile API uses two-phase result claim and token-bound artifact downloads", async () => {
  const acknowledgement = { claimedAt: now, usageConsumed: true };
  const artifact = {
    descriptor: claimSession.artifacts[0],
    bytes: Buffer.from([1, 2, 3, 4]),
  };
  const { app, beginClaimCalls, acknowledgementCalls, artifactCalls } = createFixture({
    claimSession,
    acknowledgement,
    artifact,
  });

  const begin = await app.inject(
    authorized({ method: "POST", url: `/v1/runs/${runId}/claim-result` })
  );
  assert.equal(begin.statusCode, 200);
  assert.equal(begin.json().claimToken, claimToken);
  assert.deepEqual(beginClaimCalls, [{ ownerId: userId, id: runId }]);
  assert.equal(acknowledgementCalls.length, 0);

  const missingToken = await app.inject(
    authorized({
      method: "GET",
      url: `/v1/runs/${runId}/artifacts/${artifactId}`,
    })
  );
  assert.equal(missingToken.statusCode, 404);
  assert.equal(artifactCalls.length, 0);

  const download = await app.inject(
    authorized({
      method: "GET",
      url: `/v1/runs/${runId}/artifacts/${artifactId}`,
      headers: { "x-evisaflow-claim-token": claimToken },
    })
  );
  assert.equal(download.statusCode, 200);
  assert.deepEqual(download.rawPayload, Buffer.from([1, 2, 3, 4]));
  assert.equal(artifactCalls[0].token, claimToken);

  const acknowledged = await app.inject(
    authorized({
      method: "POST",
      url: `/v1/runs/${runId}/claim-result/acknowledge`,
      payload: { claimToken, manifestHash },
    })
  );
  assert.equal(acknowledged.statusCode, 200);
  assert.deepEqual(acknowledged.json(), acknowledgement);
  assert.deepEqual(acknowledgementCalls[0].body, { claimToken, manifestHash });
  await app.close();
});

test("mobile API rejects malformed and expired claim acknowledgements safely", async () => {
  const { app } = createFixture({ claimSession });
  const malformed = await app.inject(
    authorized({
      method: "POST",
      url: `/v1/runs/${runId}/claim-result/acknowledge`,
      payload: { claimToken: "short", manifestHash },
    })
  );
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().code, "REQUEST_INVALID");

  const expired = await app.inject(
    authorized({
      method: "POST",
      url: `/v1/runs/${runId}/claim-result/acknowledge`,
      payload: { claimToken, manifestHash },
    })
  );
  assert.equal(expired.statusCode, 409);
  assert.equal(expired.json().code, "CLAIM_ACKNOWLEDGEMENT_REJECTED");
  assert.equal(expired.json().retryable, true);
  await app.close();
});

test("mobile SSE replays events after Last-Event-ID and closes on terminal state", async () => {
  const events = [
    { id: 1, runId, type: "queued", phase: "launching", createdAt: now },
    { id: 2, runId, type: "completed", phase: "completed", createdAt: now },
  ];
  const { app, runs } = createFixture({ events });
  runs.set(runId, {
    id: runId,
    clientRunId: runId,
    profileId,
    purpose: "right_to_work",
    status: "succeeded",
    phase: "completed",
    createdAt: now,
    updatedAt: now,
  });
  const response = await app.inject(
    authorized({
      method: "GET",
      url: `/v1/runs/${runId}/events`,
      headers: { "last-event-id": "1" },
    })
  );
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /^text\/event-stream/);
  assert.doesNotMatch(response.body, /id: 1\n/);
  assert.match(response.body, /id: 2\n/);
  assert.match(response.body, /"type":"completed"/);
  await app.close();
});
