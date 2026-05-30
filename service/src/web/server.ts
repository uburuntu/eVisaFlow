import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, {
  type FastifyInstance,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from "fastify";
import type { Db } from "../db/client.js";
import type { Env } from "../env.js";
import type { ArtifactStore } from "../runner/artifact-store.js";
import { getQueueStats } from "../runner/queue.js";
import type { RunEngine } from "../runner/run-engine.js";
import type { Logger } from "../utils/logger.js";
import type { EntitlementService } from "./entitlements.js";
import type { Mailer } from "./mailer.js";
import { registerAuthRoutes } from "./routes/auth.js";

/**
 * Health snapshot served by `/live` and `/ready`. This is the contract the old
 * standalone raw-HTTP health server exposed, folded into Fastify so there is a
 * single listener on `PORT`. The live runtime state (Telegram/runner/db
 * readiness, shutdown flag) is owned by `index.ts` and supplied via
 * {@link WebServerDeps.getHealth}; the queue stats are read here from the shared
 * in-process queue.
 */
export interface HealthSnapshot {
  ready: boolean;
  shuttingDown: boolean;
  startedAt: string;
  telegram?: {
    ready: boolean;
    username?: string;
    runnerRunning?: boolean;
  };
  db?: {
    ready: boolean;
  };
  queue: {
    active: number;
    waiting: number;
  };
}

export interface WebServerDeps {
  db: Db;
  engine: RunEngine;
  env: Env;
  log: Logger;
  mailer: Mailer;
  entitlements: EntitlementService;
  artifactStore: ArtifactStore;
  /**
   * Returns the current health snapshot. `index.ts` closes over its live
   * `RuntimeState` so readiness/shutdown reflect the running process; the queue
   * stats are merged in here from {@link getQueueStats} so callers need not
   * supply them.
   */
  getHealth: () => Omit<HealthSnapshot, "queue">;
  /**
   * CORS allow-list. Self-host default is same-origin (no cross-origin allowed);
   * pass explicit origins to permit a separately hosted frontend. Defaults to
   * `false` (same-origin only) when omitted.
   */
  corsOrigin?: string | string[] | boolean;
}

/**
 * The concrete Fastify instance this module builds. Its logger generic is pinned
 * to the service's pino {@link Logger} (supplied via `loggerInstance` below), so
 * route registrars must accept this flavor rather than the default
 * `FastifyBaseLogger` one — otherwise handler/route option types are incompatible.
 */
export type WebFastifyInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  Logger
>;

/**
 * Builds the configured Fastify instance for the web channel.
 *
 * Registers `@fastify/cookie` (session cookie parsing) and `@fastify/cors`
 * (same-origin by default), serves the health probes folded in from the removed
 * `health.ts`:
 * - `GET /live`  → 200 unless shutting down (process liveness).
 * - `GET /ready` → 200 only when fully ready and not shutting down.
 *
 * The body of both is the full {@link HealthSnapshot}. Authentication routes
 * (magic-link + Telegram Login + session lifecycle) are mounted via
 * {@link registerAuthRoutes}. Vault, member, run, and SSE routes mount in later
 * Phase 4 steps; the `deps` shape already carries everything those routes need
 * (db, engine, mailer, entitlements, artifactStore) so adding them does not
 * change this signature.
 */
export function createWebServer(deps: WebServerDeps): WebFastifyInstance {
  const app = Fastify({
    // Reuse the service's pino logger (with its secret redaction) as Fastify's
    // request logger so web request logs share the same redaction posture.
    loggerInstance: deps.log,
    // Trust the reverse proxy in front of the app (TLS terminator / load
    // balancer) so `request.protocol`/client IP reflect the original request.
    trustProxy: true,
    // Bound request body size. The inline-plaintext applicant on POST /api/runs
    // and opaque vault/member blobs are small; keep a tight cap. Sealed artifact
    // UPLOADS are not a thing (artifacts are produced server-side), and large
    // artifact DOWNLOADS stream out, so 1 MiB is ample for any request body.
    bodyLimit: 1 * 1024 * 1024,
  });

  app.register(cookie);
  app.register(cors, {
    // Same-origin only by default for self-host (the SPA is served by this same
    // server). `credentials` lets the browser send the session cookie when an
    // explicit origin IS configured.
    origin: deps.corsOrigin ?? false,
    credentials: true,
  });

  const snapshot = (): HealthSnapshot => ({
    ...deps.getHealth(),
    queue: getQueueStats(),
  });

  // Liveness: the process is up and not draining. Mirrors the old `/live` +
  // `/healthz` semantics (503 only while shutting down).
  app.get("/live", async (_request, reply) => {
    const body = snapshot();
    return reply.code(body.shuttingDown ? 503 : 200).send(body);
  });

  // Readiness: safe to receive traffic — fully ready and not draining. Mirrors
  // the old `/ready` + `/readyz` semantics.
  app.get("/ready", async (_request, reply) => {
    const body = snapshot();
    const ok = body.ready && !body.shuttingDown;
    return reply.code(ok ? 200 : 503).send(body);
  });

  // Authentication routes (email magic-link + Telegram Login + session
  // lifecycle). Mounted here so the cookie plugin (registered above) is available
  // for setting/reading the session cookie.
  registerAuthRoutes(app, {
    db: deps.db,
    env: deps.env,
    mailer: deps.mailer,
    log: deps.log,
  });

  return app;
}
