import assert from "node:assert/strict";
import test from "node:test";
import { SupabaseMobileAuth } from "../dist/api/mobile-auth.js";

test("mobile auth deduplicates concurrent verification and caches by token hash", async () => {
  let calls = 0;
  let release;
  const db = {
    auth: {
      async getUser(accessToken) {
        calls += 1;
        assert.equal(accessToken, "sensitive-access-token");
        await new Promise((resolve) => {
          release = resolve;
        });
        return { data: { user: { id: "user-1" } }, error: null };
      },
    },
  };
  const auth = new SupabaseMobileAuth(db);

  const first = auth.getUserId("sensitive-access-token");
  const second = auth.getUserId("sensitive-access-token");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), ["user-1", "user-1"]);
  assert.equal(await auth.getUserId("sensitive-access-token"), "user-1");
  assert.equal(calls, 1);
});

test("mobile auth expires invalid-session cache entries", async () => {
  let calls = 0;
  const db = {
    auth: {
      async getUser() {
        calls += 1;
        return { data: { user: null }, error: new Error("invalid") };
      },
    },
  };
  const auth = new SupabaseMobileAuth(db, { invalidTtlMs: 30 });

  assert.equal(await auth.getUserId("invalid-token"), null);
  assert.equal(await auth.getUserId("invalid-token"), null);
  assert.equal(calls, 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(await auth.getUserId("invalid-token"), null);
  assert.equal(calls, 2);
});

test("mobile auth invalidation wins over cached and in-flight verification", async () => {
  let calls = 0;
  let release;
  const db = {
    auth: {
      async getUser() {
        calls += 1;
        await new Promise((resolve) => {
          release = resolve;
        });
        return { data: { user: { id: "deleted-user" } }, error: null };
      },
    },
  };
  const auth = new SupabaseMobileAuth(db);

  const pending = auth.getUserId("deleted-user-token");
  await new Promise((resolve) => setImmediate(resolve));
  auth.invalidateAccessToken("deleted-user-token");
  release();

  assert.equal(await pending, null);
  assert.equal(await auth.getUserId("deleted-user-token"), null);
  assert.equal(calls, 1);
});
