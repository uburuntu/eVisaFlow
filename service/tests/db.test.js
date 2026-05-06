import assert from "node:assert/strict";
import test from "node:test";
import { updateRunStatus } from "../dist/db/runs.js";

test("updateRunStatus writes completion timestamp for terminal statuses", async () => {
  let updatePayload;
  const db = {
    from(table) {
      assert.equal(table, "runs");
      return {
        update(payload) {
          updatePayload = payload;
          return {
            eq(column, value) {
              assert.equal(column, "id");
              assert.equal(value, "run-1");
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };

  await updateRunStatus(db, "run-1", {
    status: "success",
    share_code: "ABC DEF GHI",
    valid_until: "2030-01-01T00:00:00.000Z",
  });

  assert.equal(updatePayload.status, "success");
  assert.equal(updatePayload.share_code, "ABC DEF GHI");
  assert.equal(updatePayload.valid_until, "2030-01-01T00:00:00.000Z");
  assert.equal(typeof updatePayload.completed_at, "string");
});
