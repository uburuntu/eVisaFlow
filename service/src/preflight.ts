import { createBot } from "./bot/bot.js";
import { createTwoFactorAdapter } from "./bot/two-factor-adapter.js";
import { getSupabase } from "./db/client.js";
import { loadEnv, redactedEnvSummary } from "./env.js";
import { assertSupabaseReady, assertTelegramReady } from "./readiness.js";
import { createEvisaRunJob } from "./runner/evisa-run-job.js";
import { createRunEngine } from "./runner/run-engine.js";
import { createLogger } from "./utils/logger.js";

async function main(): Promise<void> {
  const log = createLogger({ verbose: true });
  const env = loadEnv();
  log.info({ env: redactedEnvSummary(env) }, "Loaded service configuration");

  const db = getSupabase(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const engine = createRunEngine({
    runJob: createEvisaRunJob(),
    db,
    serverKeyHex: env.ENCRYPTION_KEY,
    logger: log,
  });
  const twoFactor = createTwoFactorAdapter(engine);
  const bot = createBot(env.TELEGRAM_BOT_TOKEN, db, env, log, engine, twoFactor);

  const username = await assertTelegramReady(bot);
  await assertSupabaseReady(db);
  log.info({ botUsername: username }, "Service preflight passed");
}

main().catch((err) => {
  const log = createLogger({ verbose: true });
  log.fatal({ err }, "Service preflight failed");
  process.exit(1);
});
