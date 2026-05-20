import assert from "node:assert/strict";
import test from "node:test";
import { updateRunStatus } from "../dist/db/runs.js";

function createRunsUpdateMock(result = { data: { id: "run-1" }, error: null }) {
  let updatePayload;
  const calls = [];
  const builder = {
    eq(column, value) {
      calls.push(["eq", column, value]);
      return builder;
    },
    in(column, value) {
      calls.push(["in", column, value]);
      return builder;
    },
    select(columns) {
      calls.push(["select", columns]);
      return builder;
    },
    maybeSingle() {
      calls.push(["maybeSingle"]);
      return Promise.resolve(result);
    },
  };
  const db = {
    from(table) {
      assert.equal(table, "runs");
      return {
        update(payload) {
          updatePayload = payload;
          return builder;
        },
      };
    },
  };
  return {
    db,
    calls,
    get updatePayload() {
      return updatePayload;
    },
  };
}

test("updateRunStatus writes completion timestamp for terminal statuses", async () => {
  const mock = createRunsUpdateMock();

  const updated = await updateRunStatus(mock.db, "run-1", {
    status: "success",
    encrypted_share_code: "ciphertext",
    valid_until: "2030-01-01T00:00:00.000Z",
  });

  assert.equal(updated, true);
  assert.equal(mock.updatePayload.status, "success");
  assert.equal(mock.updatePayload.encrypted_share_code, "ciphertext");
  assert.equal(mock.updatePayload.valid_until, "2030-01-01T00:00:00.000Z");
  assert.equal(typeof mock.updatePayload.completed_at, "string");
  assert.deepEqual(mock.calls[0], ["eq", "id", "run-1"]);
  assert.deepEqual(mock.calls[1], [
    "in",
    "status",
    ["pending", "running", "awaiting_2fa"],
  ]);
});

test("updateRunStatus writes interrupted metadata as terminal", async () => {
  const mock = createRunsUpdateMock({ data: { id: "run-2" }, error: null });

  await updateRunStatus(mock.db, "run-2", {
    status: "interrupted",
    error_code: "SERVICE_INTERRUPTED",
    error_message: "Service stopped",
  });

  assert.equal(mock.updatePayload.status, "interrupted");
  assert.equal(mock.updatePayload.error_code, "SERVICE_INTERRUPTED");
  assert.equal(mock.updatePayload.error_message, "Service stopped");
  assert.equal(typeof mock.updatePayload.completed_at, "string");
});

test("updateRunStatus reports a conflict when a run is no longer active", async () => {
  const mock = createRunsUpdateMock({ data: null, error: null });

  const updated = await updateRunStatus(mock.db, "run-3", {
    status: "success",
    encrypted_share_code: "ciphertext",
  });

  assert.equal(updated, false);
});
