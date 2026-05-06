import { mkdir } from "node:fs/promises";
import { run } from "@grammyjs/runner";
import { createBot } from "./bot/bot.js";
import { getSupabase } from "./db/client.js";
import { loadEnv } from "./env.js";
import { setConcurrency } from "./runner/queue.js";
import { startScheduler } from "./scheduler/cron.js";
import { createLogger } from "./utils/logger.js";

const env = loadEnv();
const log = createLogger({ verbose: true });
const db = getSupabase(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

setConcurrency(env.QUEUE_CONCURRENCY);

// Ensure output directory exists
await mkdir(env.EVISA_OUTPUT_DIR, { recursive: true });

const bot = createBot(env.TELEGRAM_BOT_TOKEN, db, env, log);
const scheduler = startScheduler(bot, db, env, log);
const runner = run(bot);

log.info({ concurrency: env.QUEUE_CONCURRENCY, cron: env.SCHEDULER_CRON }, "Bot started");

// Graceful shutdown
const shutdown = () => {
  log.info("Shutting down...");
  runner.stop();
  scheduler.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
