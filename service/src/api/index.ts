import { getSupabase } from "../db/client.js";
import { loadEnv } from "../env.js";
import { setConcurrency } from "../runner/queue.js";
import { createLogger } from "../utils/logger.js";
import { startMobileApi } from "./server.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger({ verbose: true });
  const db = getSupabase(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  setConcurrency(env.QUEUE_CONCURRENCY);
  const app = await startMobileApi({ db, env, log });

  const shutdown = async (signal: NodeJS.Signals) => {
    log.info({ signal }, "Stopping mobile API");
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", (signal) => void shutdown(signal));
  process.once("SIGTERM", (signal) => void shutdown(signal));
}

main().catch((error) => {
  createLogger({ verbose: true }).fatal({ err: error }, "Mobile API failed to start");
  process.exit(1);
});
