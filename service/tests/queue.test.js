import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelJob,
  enqueue,
  getQueueStats,
  QueueJobCancelledError,
  resetQueueForTests,
  setConcurrency,
} from "../dist/runner/queue.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("queue enforces configured concurrency and drains waiting items", async () => {
  resetQueueForTests();
  setConcurrency(1);

  const started = [];
  let releaseFirst;
  const firstStarted = new Promise((resolve) => {
    enqueue({
      id: "run-201",
      key: "201:member",
      telegramId: 201,
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

  const second = enqueue({
    id: "run-202",
    key: "202:member",
    telegramId: 202,
    memberName: "Sam",
    execute: async () => {
      started.push("second");
    },
    onPositionUpdate: () => {},
  });
  const third = enqueue({
    id: "run-203",
    key: "203:member",
    telegramId: 203,
    memberName: "Pat",
    execute: async () => {
      started.push("third");
    },
    onPositionUpdate: () => {},
  });

  await flush();
  assert.deepEqual(getQueueStats(), { active: 1, waiting: 2 });

  releaseFirst();
  await Promise.all([second.handle.done, third.handle.done]);
  await flush();

  assert.deepEqual(started, ["first", "second", "third"]);
  assert.deepEqual(getQueueStats(), { active: 0, waiting: 0 });
});

test("queue serializes jobs for the same Telegram user", async () => {
  resetQueueForTests();
  setConcurrency(2);

  const started = [];
  let releaseFirst;
  const firstStarted = new Promise((resolve) => {
    enqueue({
      id: "run-301-a",
      key: "301:a",
      telegramId: 301,
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

  const sameUser = enqueue({
    id: "run-301-b",
    key: "301:b",
    telegramId: 301,
    memberName: "Sam",
    execute: async () => {
      started.push("same-user");
    },
    onPositionUpdate: () => {},
  });
  const otherUser = enqueue({
    id: "run-302-a",
    key: "302:a",
    telegramId: 302,
    memberName: "Pat",
    execute: async () => {
      started.push("other-user");
    },
    onPositionUpdate: () => {},
  });

  await otherUser.handle.done;
  assert.deepEqual(started, ["first", "other-user"]);

  releaseFirst();
  await sameUser.handle.done;
  assert.deepEqual(started, ["first", "other-user", "same-user"]);
});

test("queue dedupes by job key", async () => {
  resetQueueForTests();
  setConcurrency(1);

  const first = enqueue({
    id: "run-401",
    key: "401:member",
    telegramId: 401,
    memberName: "Alex",
    execute: async () => {},
    onPositionUpdate: () => {},
  });
  const duplicate = enqueue({
    id: "run-duplicate",
    key: "401:member",
    telegramId: 401,
    memberName: "Alex",
    execute: async () => {},
    onPositionUpdate: () => {},
  });

  assert.equal(first.accepted, true);
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.handle.id, first.handle.id);
  await first.handle.done;
});

test("queue cancels queued jobs", async () => {
  resetQueueForTests();
  setConcurrency(1);

  let releaseFirst;
  let firstHandle;
  const firstStarted = new Promise((resolve) => {
    const first = enqueue({
      id: "run-501",
      key: "501:member",
      telegramId: 501,
      memberName: "Alex",
      execute: async () => {
        resolve();
        await new Promise((release) => {
          releaseFirst = release;
        });
      },
      onPositionUpdate: () => {},
    });
    firstHandle = first.handle;
  });
  await firstStarted;

  const second = enqueue({
    id: "run-502",
    key: "502:member",
    telegramId: 502,
    memberName: "Sam",
    execute: async () => {
      throw new Error("should not start");
    },
    onPositionUpdate: () => {},
  });

  assert.equal(cancelJob("run-502", "User cancelled"), true);
  await assert.rejects(second.handle.done, QueueJobCancelledError);

  releaseFirst();
  await firstHandle.done;
});

test("queue rejects active jobs when they are cancelled", async () => {
  resetQueueForTests();
  setConcurrency(1);

  let releaseRun;
  let firstHandle;
  const started = new Promise((resolve) => {
    const first = enqueue({
      id: "run-601",
      key: "601:member",
      telegramId: 601,
      memberName: "Alex",
      execute: async (signal) => {
        resolve();
        await new Promise((release) => {
          releaseRun = release;
          signal.addEventListener("abort", () => release(), { once: true });
        });
      },
      onPositionUpdate: () => {},
    });
    firstHandle = first.handle;
  });

  const second = enqueue({
    id: "run-602",
    key: "602:member",
    telegramId: 602,
    memberName: "Sam",
    execute: async () => {},
    onPositionUpdate: () => {},
  });

  await started;
  assert.equal(cancelJob("run-601", "User cancelled"), true);
  await assert.rejects(firstHandle.done, QueueJobCancelledError);
  releaseRun?.();
  await second.handle.done;
  assert.deepEqual(getQueueStats(), { active: 0, waiting: 0 });
});

test("queue rejects invalid concurrency", () => {
  resetQueueForTests();
  assert.throws(() => setConcurrency(0), /positive integer/);
  assert.throws(() => setConcurrency(1.5), /positive integer/);
});

test("queue ignores position notification failures", async () => {
  resetQueueForTests();
  setConcurrency(1);

  const syncFailure = enqueue({
    id: "run-notify-sync",
    key: "notify:sync",
    telegramId: 701,
    memberName: "Alex",
    execute: async () => {},
    onPositionUpdate() {
      throw new Error("sync notification failed");
    },
  });
  await syncFailure.handle.done;

  const asyncFailure = enqueue({
    id: "run-notify-async",
    key: "notify:async",
    telegramId: 702,
    memberName: "Sam",
    execute: async () => {},
    async onPositionUpdate() {
      throw new Error("async notification failed");
    },
  });
  await asyncFailure.handle.done;

  assert.deepEqual(getQueueStats(), { active: 0, waiting: 0 });
});
