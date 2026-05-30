import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "@grammyjs/runner";
import { createBot } from "./bot/bot.js";
import { createTwoFactorAdapter } from "./bot/two-factor-adapter.js";
import { closeDb, createDb, getPool } from "./db/client.js";
import { runMigrationsWithPool } from "./db/migrate.js";
import { markNonTerminalRunsInterrupted } from "./db/runs.js";
import { type Env, loadEnv, redactedEnvSummary } from "./env.js";
import { assertDbReady, assertTelegramReady } from "./readiness.js";
import { createPostgresArtifactStore } from "./runner/artifact-store.js";
import { createEvisaRunJob } from "./runner/evisa-run-job.js";
import { cancelAllJobs, setConcurrency, waitForIdle } from "./runner/queue.js";
import { createRunEngine } from "./runner/run-engine.js";
import { startCleanupScheduler } from "./scheduler/cleanup.js";
import { startScheduler } from "./scheduler/cron.js";
import { createLogger } from "./utils/logger.js";
import { unlimitedEntitlements } from "./web/entitlements.js";
import { consoleMailer, type Mailer, smtpMailer } from "./web/mailer.js";
import { createWebServer, type HealthSnapshot } from "./web/server.js";

const SHUTDOWN_DRAIN_MS = 15_000;

/**
 * Resolves the built web bundle directory to serve from Fastify.
 *
 * Honours an explicit `WEB_DIST_PATH` override; otherwise defaults to the
 * workspace `web/dist`, located relative to THIS compiled module rather than the
 * process cwd. The build output is `service/dist/index.js`, so the sibling web
 * package's build is two levels up at `../../web/dist`. Computing it from
 * `import.meta.url` means `node dist/index.js` (run from any cwd) and the
 * self-host Docker layout both resolve the bundle without configuration.
 */
function resolveWebDistPath(env: Env): string {
  if (env.WEB_DIST_PATH) {
    return path.resolve(env.WEB_DIST_PATH);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "web", "dist");
}

interface RuntimeState {
  ready: boolean;
  shuttingDown: boolean;
  startedAt: string;
  telegramReady: boolean;
  telegramUsername?: string;
  dbReady: boolean;
  runnerRunning: boolean;
}

/**
 * Builds the health snapshot from the live runtime state, minus the queue stats
 * (the web server merges those from the shared queue). Passed to
 * {@link createWebServer} as `getHealth`, preserving the readiness semantics the
 * old standalone health server had.
 */
function healthSnapshot(state: RuntimeState): Omit<HealthSnapshot, "queue"> {
  return {
    ready: state.ready && state.telegramReady && state.dbReady && state.runnerRunning,
    shuttingDown: state.shuttingDown,
    startedAt: state.startedAt,
    telegram: {
      ready: state.telegramReady,
      username: state.telegramUsername,
      runnerRunning: state.runnerRunning,
    },
    db: {
      ready: state.dbReady,
    },
  };
}

async function main(): Promise<void> {
  const log = createLogger({ verbose: true });
  let env: Env;
  try {
    env = loadEnv();
  } catch (err) {
    log.fatal({ err }, "Invalid service environment");
    process.exit(1);
    return;
  }

  log.info({ env: redactedEnvSummary(env) }, "Loaded service configuration");

  const state: RuntimeState = {
    ready: false,
    shuttingDown: false,
    startedAt: new Date().toISOString(),
    telegramReady: false,
    dbReady: false,
    runnerRunning: false,
  };

  const db = createDb(env.DATABASE_URL);
  setConcurrency(env.QUEUE_CONCURRENCY);

  // Postgres-backed store for sealed output artifacts (self-host v1: bytes inline
  // in `run_artifacts`). Bytes are ALWAYS sealed before they reach it. Shared by
  // the engine (writes sealed artifacts) and the cleanup cron (deletes expired).
  const artifactStore = createPostgresArtifactStore(db, {
    ttlMs: env.ARTIFACT_TTL_MINUTES * 60_000,
  });

  // Single run engine drives every queued run (bot today, web later). It owns
  // applicant resolution, the queue slot, run-event publishing, custody-aware
  // output sealing, and DB persistence; the bot subscribes to drive the Telegram
  // UI. The default custody selector wires serverCustody(ENCRYPTION_KEY) for the
  // trusted bot and clientCustody() for E2EE web runs; sealed artifacts are
  // persisted via the artifact store above.
  const engine = createRunEngine({
    runJob: createEvisaRunJob(),
    db,
    serverKeyHex: env.ENCRYPTION_KEY,
    artifactStore,
    logger: log,
  });

  // Outbound email transport for magic-link sign-in. SMTP when SMTP_URL is set
  // (SMTP_FROM is validated as required alongside it); otherwise a console
  // transport that logs the link for SMTP-less dev/self-host. Telegram Login
  // needs neither, so a Telegram-only deployment can run with the console mailer.
  const mailer: Mailer =
    env.SMTP_URL && env.SMTP_FROM
      ? smtpMailer({ url: env.SMTP_URL, from: env.SMTP_FROM })
      : consoleMailer(log);

  // Telegram-specific 2FA reply matcher: maps incoming code messages back to the
  // engine's runId-keyed gate. Shared between the run driver (registration) and
  // the 2FA middleware (matching).
  const twoFactor = createTwoFactorAdapter(engine);

  const bot = createBot(env.TELEGRAM_BOT_TOKEN, db, env, log, engine, twoFactor);

  // Web server (Fastify): the API channel, the folded-in health probes, and the
  // built web app (web/dist, with an SPA fallback for /app/*) all share this one
  // listener on PORT. Started before the readiness checks so `/live` and `/ready`
  // answer during boot — both report 503 until `state` flips ready, matching the
  // old standalone health server's behavior. The deps carry the auth/vault/
  // member/run wiring plus the resolved web-bundle path.
  const app = createWebServer({
    db,
    engine,
    env,
    log,
    mailer,
    entitlements: unlimitedEntitlements,
    artifactStore,
    getHealth: () => healthSnapshot(state),
    // Serve the built Astro app (web/dist) from this same origin with an SPA
    // fallback for /app/*. Path is the WEB_DIST_PATH override or the workspace
    // default; missing builds degrade gracefully (API stays up, hint logged).
    webDistPath: resolveWebDistPath(env),
  });
  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    log.info({ port: env.PORT }, "Web server listening");
  } catch (err) {
    log.fatal({ err }, "Failed to start web server");
    process.exit(1);
    return;
  }

  try {
    const username = await assertTelegramReady(bot);
    state.telegramReady = true;
    state.telegramUsername = username;
    // Bring the schema up to date before readiness. Baseline-safe and idempotent:
    // a no-op against an already-migrated database, and it auto-provisions a fresh
    // self-host database so the bot can start without manual SQL.
    const migrateResult = await runMigrationsWithPool(getPool(db), log);
    log.info(
      {
        baselined: migrateResult.baselined,
        applied: migrateResult.applied,
      },
      "Database migrations ready"
    );
    await assertDbReady(db);
    state.dbReady = true;
    await markNonTerminalRunsInterrupted(
      db,
      "Service restarted before the run completed"
    );
  } catch (err) {
    log.fatal({ err }, "Startup readiness check failed");
    await app.close().catch(() => {});
    process.exit(1);
    return;
  }

  const scheduler = startScheduler(bot, db, env, log);
  // Periodic housekeeping: deletes expired sealed artifacts, expired sessions,
  // and consumed/expired magic-link tokens on CLEANUP_CRON.
  const cleanupScheduler = startCleanupScheduler(db, artifactStore, env, log);
  const runner = run(bot);
  state.runnerRunning = runner.isRunning();
  void runner
    .task()
    ?.then(() => {
      state.runnerRunning = false;
      state.ready = false;
      log.warn("Bot runner stopped");
    })
    .catch((err) => {
      state.runnerRunning = false;
      state.ready = false;
      log.error({ err }, "Bot runner crashed");
    });
  state.ready = true;

  log.info(
    {
      concurrency: env.QUEUE_CONCURRENCY,
      cron: env.SCHEDULER_CRON,
      cleanupCron: env.CLEANUP_CRON,
      botUsername: state.telegramUsername,
    },
    "Bot started"
  );

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (state.shuttingDown) {
      return;
    }
    state.ready = false;
    state.shuttingDown = true;
    log.info({ signal }, "Shutting down");

    scheduler.stop();
    cleanupScheduler.stop();
    await Promise.resolve(runner.stop());
    const interruptedRunIds = cancelAllJobs(`Service received ${signal}`, "interrupted");
    const drained = await waitForIdle(SHUTDOWN_DRAIN_MS);
    if (!drained) {
      log.warn({ timeoutMs: SHUTDOWN_DRAIN_MS }, "Timed out waiting for queue drain");
    }

    await markNonTerminalRunsInterrupted(
      db,
      `Service stopped before the run completed (${signal})`,
      { runIds: interruptedRunIds }
    ).catch((err) => {
      log.warn({ err }, "Failed to mark interrupted runs");
    });
    await app.close().catch((err) => {
      log.warn({ err }, "Failed to close web server");
    });
    await closeDb(db).catch((err) => {
      log.warn({ err }, "Failed to close database pool");
    });
    process.exit(drained ? 0 : 1);
  };

  process.on("SIGINT", (signal) => {
    void shutdown(signal);
  });
  process.on("SIGTERM", (signal) => {
    void shutdown(signal);
  });
}

main().catch((err) => {
  const log = createLogger({ verbose: true });
  log.fatal({ err }, "Fatal service error");
  process.exit(1);
});
