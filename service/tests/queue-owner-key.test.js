import assert from "node:assert/strict";
import test from "node:test";
import {
  enqueue,
  getJobInfo,
  getPosition,
  getQueueStats,
  resetQueueForTests,
  setConcurrency,
} from "../dist/runner/queue.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("enqueue exposes the ownerKey on the handle and job info", async () => {
  resetQueueForTests();
  setConcurrency(1);

  const result = enqueue({
    id: "run-owner-2",
    key: "owner-2:member",
    ownerKey: "user-uuid-abc",
    memberName: "Sam",
    execute: async () => {},
    onPositionUpdate: () => {},
  });

  assert.equal(result.accepted, true);
  assert.equal(result.handle.ownerKey, "user-uuid-abc");

  const info = getJobInfo("run-owner-2");
  assert.equal(info.ownerKey, "user-uuid-abc");

  await result.handle.done;
});

test("queue serializes jobs that share an ownerKey", async () => {
  resetQueueForTests();
  setConcurrency(2);

  const started = [];
  let releaseFirst;
  const firstStarted = new Promise((resolve) => {
    enqueue({
      id: "run-owner-a",
      key: "ownerA:a",
      ownerKey: "owner-A",
      memberName: "Alex",
      execute: async () => {
        started.push("first");
        resolve();
        await new Promise((release) => {
          releaseFirst = release;
        });
      },
      onPositionUpdate: () => {},
    });
  });

  await firstStarted;

  // Same ownerKey -> must wait even though concurrency has a free slot.
  const sameOwner = enqueue({
    id: "run-owner-b",
    key: "ownerA:b",
    ownerKey: "owner-A",
    memberName: "Sam",
    execute: async () => {
      started.push("same-owner");
    },
    onPositionUpdate: () => {},
  });

  // Different ownerKey -> may run concurrently.
  const otherOwner = enqueue({
    id: "run-owner-c",
    key: "ownerB:a",
    ownerKey: "owner-B",
    memberName: "Pat",
    execute: async () => {
      started.push("other-owner");
    },
    onPositionUpdate: () => {},
  });

  await otherOwner.handle.done;
  assert.deepEqual(started, ["first", "other-owner"]);

  releaseFirst();
  await sameOwner.handle.done;
  assert.deepEqual(started, ["first", "other-owner", "same-owner"]);
});

test("ownerKey serialization is exact-string keyed", async () => {
  resetQueueForTests();
  setConcurrency(2);

  const started = [];
  let releaseFirst;
  const firstStarted = new Promise((resolve) => {
    enqueue({
      id: "run-mixed-a",
      key: "mixed:a",
      ownerKey: "909",
      memberName: "Alex",
      execute: async () => {
        started.push("first");
        resolve();
        await new Promise((release) => {
          releaseFirst = release;
        });
      },
      onPositionUpdate: () => {},
    });
  });

  await firstStarted;

  // The same ownerKey string must serialize behind the running job.
  const sameOwnerByKey = enqueue({
    id: "run-mixed-b",
    key: "mixed:b",
    ownerKey: "909",
    memberName: "Sam",
    execute: async () => {
      started.push("same-owner");
    },
    onPositionUpdate: () => {},
  });

  await flush();
  assert.deepEqual(getQueueStats(), { active: 1, waiting: 1 });
  assert.deepEqual(started, ["first"]);

  releaseFirst();
  await sameOwnerByKey.handle.done;
  assert.deepEqual(started, ["first", "same-owner"]);
});

test("queue dedupes by key regardless of ownerKey", async () => {
  resetQueueForTests();
  setConcurrency(1);

  let releaseFirst;
  const firstStarted = new Promise((resolve) => {
    enqueue({
      id: "run-dedupe-1",
      key: "dedupe:member",
      ownerKey: "owner-A",
      memberName: "Alex",
      execute: async () => {
        resolve();
        await new Promise((release) => {
          releaseFirst = release;
        });
      },
      onPositionUpdate: () => {},
    });
  });
  await firstStarted;

  const duplicate = enqueue({
    id: "run-dedupe-2",
    key: "dedupe:member",
    ownerKey: "owner-B",
    memberName: "Sam",
    execute: async () => {},
    onPositionUpdate: () => {},
  });

  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.handle.id, "run-dedupe-1");
  assert.equal(duplicate.handle.ownerKey, "owner-A");

  releaseFirst();
  await duplicate.handle.done;
});

test("queue reports positions for waiting same-owner jobs", async () => {
  resetQueueForTests();
  setConcurrency(2);

  let releaseFirst;
  const positions = { second: [], third: [] };

  const firstStarted = new Promise((resolve) => {
    enqueue({
      id: "run-pos-a",
      key: "pos:a",
      ownerKey: "owner-pos",
      memberName: "Alex",
      execute: async () => {
        resolve();
        await new Promise((release) => {
          releaseFirst = release;
        });
      },
      onPositionUpdate: () => {},
    });
  });
  await firstStarted;

  const second = enqueue({
    id: "run-pos-b",
    key: "pos:b",
    ownerKey: "owner-pos",
    memberName: "Sam",
    execute: async () => {},
    onPositionUpdate: (pos) => {
      positions.second.push(pos);
    },
  });
  const third = enqueue({
    id: "run-pos-c",
    key: "pos:c",
    ownerKey: "owner-pos",
    memberName: "Pat",
    execute: async () => {},
    onPositionUpdate: (pos) => {
      positions.third.push(pos);
    },
  });

  await flush();
  // First is running; the two same-owner jobs are blocked and wait in order.
  assert.deepEqual(getQueueStats(), { active: 1, waiting: 2 });
  assert.equal(getPosition(), 2);
  assert.equal(second.position, 1);
  assert.equal(third.position, 2);

  releaseFirst();
  await Promise.all([second.handle.done, third.handle.done]);
  await flush();

  assert.deepEqual(getQueueStats(), { active: 0, waiting: 0 });
  // The trailing job advanced to position 1 before running.
  assert.ok(positions.third.includes(1));
});
