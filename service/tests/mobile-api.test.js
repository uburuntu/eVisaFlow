import assert from "node:assert/strict";
import test from "node:test";
import { buildMobileApi } from "../dist/api/app.js";
import { createLogger } from "../dist/utils/logger.js";

const userId = "9591fc30-b78f-4282-8fc9-ae662d725ad1";
const profileId = "1f8f9e99-f0ea-4591-a745-aabf871febc1";
const runId = "c6d85ab7-22cd-4ef7-a394-e82c0fd8226b";
const now = "2026-08-01T09:00:00.000Z";

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

function createFixture() {
  const runs = new Map();
  const started = [];
  const cancelled = [];
  const slots = new Set();
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
    async getEvents() {
      return [];
    },
    async updateRun(id, update) {
      runs.set(id, { ...runs.get(id), ...update });
    },
    async claimResult() {
      return null;
    },
    async downloadArtifact() {
      return null;
    },
  };
  const coordinator = {
    start(ownerId, request) {
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
  const app = buildMobileApi({ auth, coordinator, store, log: createLogger() });
  return {
    app,
    runs,
    slots,
    started,
    cancelled,
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
