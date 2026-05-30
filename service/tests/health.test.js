import assert from "node:assert/strict";
import test from "node:test";
import { startHealthServer } from "../dist/health.js";

const log = {
  info() {},
};

test("health server reports live and ready status", async () => {
  let ready = false;
  const server = startHealthServer(0, log, () => ({
    ready,
    shuttingDown: false,
    startedAt: new Date(0).toISOString(),
    telegram: { ready: true, username: "bot" },
    db: { ready: true },
    queue: { active: 0, waiting: 0 },
  }));

  try {
    await new Promise((resolve) => setImmediate(resolve));
    const port = server.port();
    assert.equal(typeof port, "number");

    const live = await fetch(`http://127.0.0.1:${port}/live`);
    assert.equal(live.status, 200);

    const notReady = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(notReady.status, 503);

    ready = true;
    const readyResponse = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(readyResponse.status, 200);
  } finally {
    await server.close();
  }
});
