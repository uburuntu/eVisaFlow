import assert from "node:assert/strict";
import test from "node:test";
import { createWebServer } from "../dist/web/server.js";

// Verifies the health probes folded into the Fastify web server via
// `fastify.inject` (no network listener needed). Mirrors the readiness semantics
// the old standalone health server had:
//   - /live  → 200 unless shutting down
//   - /ready → 200 only when fully ready and not shutting down
// These routes touch none of the other deps (db/engine/mailer/...), so they are
// supplied as inert stubs; only `getHealth` drives the behavior under test.

// Fastify's loggerInstance validation requires fatal/trace (in addition to the
// usual levels) and a child() factory, so provide the full set even though the
// health probes themselves only ever log via this no-op stub.
const log = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  fatal() {},
  trace() {},
  child: () => log,
};

/** Minimal deps for the web server; only `getHealth` matters to the probes. */
function makeServer(getHealth) {
  return createWebServer({
    db: {},
    engine: {},
    env: {},
    log,
    mailer: { async sendMagicLink() {} },
    entitlements: {
      async canCreateRun() {
        return true;
      },
      async maxMembers() {
        return 6;
      },
    },
    artifactStore: {},
    getHealth,
  });
}

test("GET /live is 200 while up, 503 while shutting down", async () => {
  let shuttingDown = false;
  const app = makeServer(() => ({
    ready: true,
    shuttingDown,
    startedAt: new Date(0).toISOString(),
    telegram: { ready: true, username: "bot", runnerRunning: true },
    db: { ready: true },
  }));
  try {
    const up = await app.inject({ method: "GET", url: "/live" });
    assert.equal(up.statusCode, 200);
    const body = up.json();
    assert.equal(body.shuttingDown, false);
    // Queue stats are merged in by the server from the shared in-process queue.
    assert.ok(body.queue);
    assert.equal(typeof body.queue.active, "number");
    assert.equal(typeof body.queue.waiting, "number");

    shuttingDown = true;
    const draining = await app.inject({ method: "GET", url: "/live" });
    assert.equal(draining.statusCode, 503);
  } finally {
    await app.close();
  }
});

test("GET /ready is 503 until ready, 200 when ready", async () => {
  let ready = false;
  const app = makeServer(() => ({
    ready,
    shuttingDown: false,
    startedAt: new Date(0).toISOString(),
    telegram: { ready: true, username: "bot", runnerRunning: true },
    db: { ready: true },
  }));
  try {
    const notReady = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(notReady.statusCode, 503);

    ready = true;
    const readyResponse = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(readyResponse.statusCode, 200);
    assert.equal(readyResponse.json().ready, true);
  } finally {
    await app.close();
  }
});

test("GET /ready is 503 when ready but shutting down", async () => {
  const app = makeServer(() => ({
    ready: true,
    shuttingDown: true,
    startedAt: new Date(0).toISOString(),
  }));
  try {
    const res = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(res.statusCode, 503);
  } finally {
    await app.close();
  }
});
