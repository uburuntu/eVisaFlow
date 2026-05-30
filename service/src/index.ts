import { run } from "@grammyjs/runner";
import { createBot } from "./bot/bot.js";
import { createTwoFactorAdapter } from "./bot/two-factor-adapter.js";
import { closeDb, createDb, getPool } from "./db/client.js";
import { runMigrationsWithPool } from "./db/migrate.js";
import { markNonTerminalRunsInterrupted } from "./db/runs.js";
import { type Env, loadEnv, redactedEnvSummary } from "./env.js";
import { startHealthServer } from "./health.js";
import { assertDbReady, assertTelegramReady } from "./readiness.js";
import { createEvisaRunJob } from "./runner/evisa-run-job.js";
import {
  cancelAllJobs,
  getQueueStats,
  setConcurrency,
  waitForIdle,
} from "./runner/queue.js";
import { createRunEngine } from "./runner/run-engine.js";
import { startScheduler } from "./scheduler/cron.js";
import { createLogger } from "./utils/logger.js";

const SHUTDOWN_DRAIN_MS = 15_000;

interface RuntimeState {
  ready: boolean;
  shuttingDown: boolean;
  startedAt: string;
  telegramReady: boolean;
  telegramUsername?: string;
  dbReady: boolean;
  runnerRunning: boolean;
}

function healthSnapshot(state: RuntimeState) {
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
    queue: getQueueStats(),
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

  const health = startHealthServer(env.HEALTH_PORT, log, () => healthSnapshot(state));
  const db = createDb(env.DATABASE_URL);
  setConcurrency(env.QUEUE_CONCURRENCY);

  // Single run engine drives every queued run (bot today, web later). It owns
  // applicant resolution, the queue slot, run-event publishing, output sealing,
  // and DB persistence; the bot subscribes to drive the Telegram UI.
  const engine = createRunEngine({
    runJob: createEvisaRunJob(),
    db,
    serverKeyHex: env.ENCRYPTION_KEY,
    logger: log,
  });

  // Telegram-specific 2FA reply matcher: maps incoming code messages back to the
  // engine's runId-keyed gate. Shared between the run driver (registration) and
  // the 2FA middleware (matching).
  const twoFactor = createTwoFactorAdapter(engine);

  const bot = createBot(env.TELEGRAM_BOT_TOKEN, db, env, log, engine, twoFactor);

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
    await health.close().catch(() => {});
    process.exit(1);
    return;
  }

  const scheduler = startScheduler(bot, db, env, log);
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
    await closeDb(db).catch((err) => {
      log.warn({ err }, "Failed to close database pool");
    });
    await health.close().catch((err) => {
      log.warn({ err }, "Failed to close health server");
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
