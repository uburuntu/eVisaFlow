import { createBot } from "./bot/bot.js";
import { createTwoFactorAdapter } from "./bot/two-factor-adapter.js";
import { closeDb, createDb } from "./db/client.js";
import { loadEnv, redactedEnvSummary } from "./env.js";
import { assertDbReady, assertTelegramReady } from "./readiness.js";
import { createEvisaRunJob } from "./runner/evisa-run-job.js";
import { createRunEngine } from "./runner/run-engine.js";
import { createLogger } from "./utils/logger.js";

async function main(): Promise<void> {
  const log = createLogger({ verbose: true });
  const env = loadEnv();
  log.info({ env: redactedEnvSummary(env) }, "Loaded service configuration");

  const db = createDb(env.DATABASE_URL);
  const engine = createRunEngine({
    runJob: createEvisaRunJob(),
    db,
    serverKeyHex: env.ENCRYPTION_KEY,
    logger: log,
  });

  try {
    // Database connectivity is always required (web + bot both depend on it).
    await assertDbReady(db);

    // Telegram is OPT-IN: only build the bot and verify Bot API reachability when
    // ENABLE_BOT is true. A pure-web deployment has no bot token and must pass
    // preflight on DB connectivity alone.
    if (env.ENABLE_BOT) {
      const token = env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        // env validation guarantees this when ENABLE_BOT is true; defensive only.
        throw new Error("ENABLE_BOT is true but TELEGRAM_BOT_TOKEN is missing");
      }
      const twoFactor = createTwoFactorAdapter(engine);
      const bot = createBot(token, db, env, log, engine, twoFactor);
      const username = await assertTelegramReady(bot);
      log.info({ botUsername: username }, "Service preflight passed (web + bot)");
    } else {
      log.info("Service preflight passed (web-only; bot disabled)");
    }
  } finally {
    await closeDb(db).catch(() => {});
  }
}

main().catch((err) => {
  const log = createLogger({ verbose: true });
  log.fatal({ err }, "Service preflight failed");
  process.exit(1);
});
