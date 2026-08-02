import { run } from "@grammyjs/runner";
import { startMobileApi } from "./api/server.js";
import { createBot } from "./bot/bot.js";
import { getSupabase } from "./db/client.js";
import { markNonTerminalRunsInterrupted } from "./db/runs.js";
import { type Env, loadEnv, redactedEnvSummary } from "./env.js";
import { startHealthServer } from "./health.js";
import { assertSupabaseReady, assertTelegramReady } from "./readiness.js";
import {
  cancelAllJobs,
  getQueueStats,
  setConcurrency,
  waitForIdle,
} from "./runner/queue.js";
import { startScheduler } from "./scheduler/cron.js";
import { createLogger } from "./utils/logger.js";

const SHUTDOWN_DRAIN_MS = 15_000;

interface RuntimeState {
  ready: boolean;
  shuttingDown: boolean;
  startedAt: string;
  telegramReady: boolean;
  telegramUsername?: string;
  supabaseReady: boolean;
  mobileApiReady: boolean;
  runnerRunning: boolean;
}

function healthSnapshot(state: RuntimeState) {
  return {
    ready:
      state.ready &&
      state.telegramReady &&
      state.supabaseReady &&
      state.mobileApiReady &&
      state.runnerRunning,
    shuttingDown: state.shuttingDown,
    startedAt: state.startedAt,
    telegram: {
      ready: state.telegramReady,
      username: state.telegramUsername,
      runnerRunning: state.runnerRunning,
    },
    supabase: {
      ready: state.supabaseReady,
    },
    mobileApi: {
      ready: state.mobileApiReady,
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
    supabaseReady: false,
    mobileApiReady: false,
    runnerRunning: false,
  };

  const health = startHealthServer(env.HEALTH_PORT, log, () => healthSnapshot(state));
  const db = getSupabase(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  setConcurrency(env.QUEUE_CONCURRENCY);
  let mobileApi: Awaited<ReturnType<typeof startMobileApi>> | undefined;

  const bot = createBot(env.TELEGRAM_BOT_TOKEN, db, env, log);

  try {
    const username = await assertTelegramReady(bot);
    state.telegramReady = true;
    state.telegramUsername = username;
    await assertSupabaseReady(db);
    state.supabaseReady = true;
    await markNonTerminalRunsInterrupted(
      db,
      "Service restarted before the run completed"
    );
    mobileApi = await startMobileApi({ db, env, log });
    state.mobileApiReady = true;
  } catch (err) {
    log.fatal({ err }, "Startup readiness check failed");
    await mobileApi?.close().catch(() => {});
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
    state.mobileApiReady = false;
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
    await mobileApi?.close().catch((err) => {
      log.warn({ err }, "Failed to close mobile API");
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
