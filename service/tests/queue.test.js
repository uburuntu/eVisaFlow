import assert from "node:assert/strict";
import test from "node:test";
import {
  enqueue,
  getPosition,
  getQueueStats,
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
    const first = enqueue(
      201,
      "Alex",
      async () => {
        started.push("first");
        resolve();
        await new Promise((release) => {
          releaseFirst = release;
        });
      },
      () => {}
    );
    first.catch(() => {});
  });

  await firstStarted;

  const second = enqueue(
    202,
    "Sam",
    async () => {
      started.push("second");
    },
    () => {}
  );
  const third = enqueue(
    203,
    "Pat",
    async () => {
      started.push("third");
    },
    () => {}
  );

  await flush();
  assert.deepEqual(getQueueStats(), { active: 1, waiting: 2 });
  assert.equal(getPosition(), 2);

  releaseFirst();
  await Promise.all([second, third]);
  await flush();

  assert.deepEqual(started, ["first", "second", "third"]);
  assert.deepEqual(getQueueStats(), { active: 0, waiting: 0 });
});
