import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebServer } from "../dist/web/server.js";

// Verifies the static web bundle + SPA fallback wired into the Fastify web
// server (Phase 5 Step D), entirely via `fastify.inject` (no listener). The
// bundle is a tiny hermetic fixture written to a temp dir rather than the real
// Astro `web/dist`, so this test is fast and independent of the web build while
// still exercising the real `@fastify/static` mount and the not-found SPA
// fallback. Contract under test:
//   - GET /                serves the built shell (web/dist/index.html)
//   - GET /_astro/*        serves real hashed assets
//   - GET /app + /app/*    fall back to the app shell (web/dist/app/index.html)
//   - GET /api/* (unknown) stays a JSON 404 (never the HTML shell)
//   - GET /api/vault       still routes to the real handler (401), proving the
//                          static layer never shadows concrete API routes
//   - no web/dist          degrades gracefully (API up, JSON 404 for /)

// Fastify's loggerInstance validation needs the full level set plus child().
const log = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  fatal() {},
  trace() {},
  child: () => log,
};

const health = () => ({
  ready: true,
  shuttingDown: false,
  startedAt: new Date(0).toISOString(),
});

const entitlements = {
  async canCreateRun() {
    return true;
  },
  async maxMembers() {
    return 6;
  },
};

/** Builds the web server with the given (optional) web-dist path. */
function makeServer(webDistPath) {
  return createWebServer({
    db: {},
    engine: {},
    env: {},
    log,
    mailer: { async sendMagicLink() {} },
    entitlements,
    artifactStore: {},
    getHealth: health,
    webDistPath,
  });
}

// Sentinel strings unique to each fixture file so assertions can tell which file
// the server actually served.
const ROOT_MARKER = "ROOT_SHELL_MARKER";
const APP_MARKER = "APP_SHELL_MARKER";
const NOT_FOUND_MARKER = "NOT_FOUND_PAGE_MARKER";
const MARKETING_MARKER = "LOGIN_PAGE_MARKER";
const ASSET_BODY = "console.log('asset');";

/**
 * Writes a minimal Astro-like build (directory format) into a fresh temp dir and
 * returns its path. Mirrors the real layout: `index.html`, `app/index.html`, a
 * directory-format marketing page (`login/index.html`), `404.html`, and a hashed
 * asset under `_astro/`.
 */
function writeFixtureDist() {
  const dir = mkdtempSync(path.join(tmpdir(), "evisa-web-dist-"));
  writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html><title>${ROOT_MARKER}</title>`
  );
  writeFileSync(
    path.join(dir, "404.html"),
    `<!doctype html><title>${NOT_FOUND_MARKER}</title>`
  );
  mkdirSync(path.join(dir, "app"), { recursive: true });
  writeFileSync(
    path.join(dir, "app", "index.html"),
    `<!doctype html><title>${APP_MARKER}</title>`
  );
  // A directory-format marketing page: Astro emits it at `login/index.html`, so
  // it is reachable at `/login/` (trailing slash). The bare `/login` must 301 to
  // it (see the redirect test below).
  mkdirSync(path.join(dir, "login"), { recursive: true });
  writeFileSync(
    path.join(dir, "login", "index.html"),
    `<!doctype html><title>${MARKETING_MARKER}</title>`
  );
  mkdirSync(path.join(dir, "_astro"), { recursive: true });
  writeFileSync(path.join(dir, "_astro", "app.ABC123.js"), ASSET_BODY);
  return dir;
}

test("GET / serves the built web shell when web/dist exists", async () => {
  const dist = writeFixtureDist();
  const app = makeServer(dist);
  try {
    const res = await app.inject({ method: "GET", url: "/" });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] ?? "", /text\/html/);
    assert.match(res.body, new RegExp(ROOT_MARKER));
  } finally {
    await app.close();
    rmSync(dist, { recursive: true, force: true });
  }
});

test("GET /_astro/* serves real hashed assets", async () => {
  const dist = writeFixtureDist();
  const app = makeServer(dist);
  try {
    const res = await app.inject({ method: "GET", url: "/_astro/app.ABC123.js" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, ASSET_BODY);
  } finally {
    await app.close();
    rmSync(dist, { recursive: true, force: true });
  }
});

test("bare directory path 301-redirects to its trailing-slash page", async () => {
  const dist = writeFixtureDist();
  const app = makeServer(dist);
  try {
    // The canonical trailing-slash URL serves the page directly.
    const canonical = await app.inject({ method: "GET", url: "/login/" });
    assert.equal(canonical.statusCode, 200);
    assert.match(canonical.body, new RegExp(MARKETING_MARKER));

    // The bare path redirects (301) to the trailing-slash canonical rather than
    // hitting the 404 fallback — so a typed/linked slash-less marketing URL still
    // resolves to the page.
    const bare = await app.inject({ method: "GET", url: "/login" });
    assert.equal(bare.statusCode, 301);
    assert.equal(bare.headers.location, "/login/");

    // The query string survives the redirect.
    const withQuery = await app.inject({ method: "GET", url: "/login?next=/app" });
    assert.equal(withQuery.statusCode, 301);
    assert.equal(withQuery.headers.location, "/login/?next=/app");
  } finally {
    await app.close();
    rmSync(dist, { recursive: true, force: true });
  }
});

test("GET /app and unknown /app/* fall back to the app shell", async () => {
  const dist = writeFixtureDist();
  const app = makeServer(dist);
  try {
    // The shell itself (a real file) — served directly.
    const shell = await app.inject({ method: "GET", url: "/app" });
    assert.equal(shell.statusCode, 200);
    assert.match(shell.body, new RegExp(APP_MARKER));

    // A deep client route with no file on disk → SPA fallback to the app shell,
    // 200 so the browser router can resolve it (not a 404).
    const deep = await app.inject({ method: "GET", url: "/app/run/abc-123" });
    assert.equal(deep.statusCode, 200);
    assert.match(deep.headers["content-type"] ?? "", /text\/html/);
    assert.match(deep.body, new RegExp(APP_MARKER));

    // A deep link with a query string still resolves to the shell.
    const withQuery = await app.inject({ method: "GET", url: "/app/history?page=2" });
    assert.equal(withQuery.statusCode, 200);
    assert.match(withQuery.body, new RegExp(APP_MARKER));
  } finally {
    await app.close();
    rmSync(dist, { recursive: true, force: true });
  }
});

test("unknown /api/* stays a JSON 404 (never the app shell)", async () => {
  const dist = writeFixtureDist();
  const app = makeServer(dist);
  try {
    const res = await app.inject({ method: "GET", url: "/api/nope" });
    assert.equal(res.statusCode, 404);
    assert.match(res.headers["content-type"] ?? "", /application\/json/);
    const body = res.json();
    assert.equal(body.statusCode, 404);
    // Must NOT be the HTML shell.
    assert.doesNotMatch(res.body, new RegExp(APP_MARKER));
    assert.doesNotMatch(res.body, new RegExp(ROOT_MARKER));

    // A POST to an unknown API path is likewise a JSON 404, not an HTML load.
    const post = await app.inject({ method: "POST", url: "/api/also-nope" });
    assert.equal(post.statusCode, 404);
    assert.match(post.headers["content-type"] ?? "", /application\/json/);
  } finally {
    await app.close();
    rmSync(dist, { recursive: true, force: true });
  }
});

test("concrete API routes keep precedence over the static layer", async () => {
  const dist = writeFixtureDist();
  const app = makeServer(dist);
  try {
    // /api/vault is a real route guarded by requireUser; with no session cookie
    // it must 401 (JSON). If the static mount or SPA fallback had shadowed it we
    // would instead get HTML or a 404 here.
    const res = await app.inject({ method: "GET", url: "/api/vault" });
    assert.equal(res.statusCode, 401);
    assert.match(res.headers["content-type"] ?? "", /application\/json/);
    assert.deepEqual(res.json(), { error: "unauthorized" });

    // Health probes still answer (folded-in, registered before static).
    const ready = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(ready.statusCode, 200);
  } finally {
    await app.close();
    rmSync(dist, { recursive: true, force: true });
  }
});

test("unknown non-app navigation serves the built 404 page", async () => {
  const dist = writeFixtureDist();
  const app = makeServer(dist);
  try {
    const res = await app.inject({ method: "GET", url: "/totally-unknown" });
    assert.equal(res.statusCode, 404);
    assert.match(res.headers["content-type"] ?? "", /text\/html/);
    assert.match(res.body, new RegExp(NOT_FOUND_MARKER));
  } finally {
    await app.close();
    rmSync(dist, { recursive: true, force: true });
  }
});

test("degrades gracefully when the web bundle is absent", async () => {
  // Point at a path with no index.html: nothing static is registered, but the
  // API/health endpoints must stay fully functional.
  const missing = path.join(tmpdir(), `evisa-web-dist-missing-${Date.now()}`);
  const app = makeServer(missing);
  try {
    const ready = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(ready.statusCode, 200);

    // With no bundle there is no shell to serve, so / is a plain JSON 404 from
    // Fastify's default handler (no SPA fallback was installed).
    const root = await app.inject({ method: "GET", url: "/" });
    assert.equal(root.statusCode, 404);
    assert.match(root.headers["content-type"] ?? "", /application\/json/);

    // The API still routes.
    const vault = await app.inject({ method: "GET", url: "/api/vault" });
    assert.equal(vault.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("no static serving when webDistPath is omitted", async () => {
  // Tests/API-only deployments pass no path at all: server builds, API works, no
  // static routes or SPA fallback exist.
  const app = makeServer(undefined);
  try {
    const ready = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(ready.statusCode, 200);
    const root = await app.inject({ method: "GET", url: "/" });
    assert.equal(root.statusCode, 404);
    assert.match(root.headers["content-type"] ?? "", /application\/json/);
  } finally {
    await app.close();
  }
});
