import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { Logger } from "../utils/logger.js";
import { buildMobileApi } from "./app.js";
import { SupabaseMobileAuth } from "./mobile-auth.js";
import { MobileRunCoordinator } from "./mobile-run-coordinator.js";
import { MobileStore } from "./mobile-store.js";

export async function startMobileApi(options: {
  db: SupabaseClient;
  env: Env;
  log: Logger;
}) {
  const store = new MobileStore(
    options.db,
    options.env.ENCRYPTION_KEY,
    options.env.MOBILE_BETA_DAILY_RUN_LIMIT
  );
  await store.interruptActiveRuns();
  const cleanup = await store.cleanupExpiredData();
  if (cleanup.artifactsDeleted > 0 || cleanup.eventsDeleted > 0) {
    options.log.info(cleanup, "Cleaned expired mobile data at startup");
  }

  const app = buildMobileApi({
    auth: new SupabaseMobileAuth(options.db),
    coordinator: new MobileRunCoordinator(store, options.env, options.log),
    store,
    log: options.log,
  });
  const address = await app.listen({
    host: options.env.MOBILE_API_HOST,
    port: options.env.MOBILE_API_PORT,
  });
  options.log.info({ address }, "Mobile API started");
  return app;
}
