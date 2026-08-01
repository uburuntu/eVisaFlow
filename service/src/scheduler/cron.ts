import type { SupabaseClient } from "@supabase/supabase-js";
import type { Bot } from "grammy";
import cron from "node-cron";
import { MobileStore } from "../api/mobile-store.js";
import type { MyContext } from "../bot/context.js";
import type { Env } from "../env.js";
import type { Logger } from "../utils/logger.js";
import { runScheduledChecks } from "./scheduled-run.js";

export interface ServiceScheduler {
  stop(): void;
}

export function startScheduler(
  bot: Bot<MyContext>,
  db: SupabaseClient,
  env: Env,
  log: Logger
): ServiceScheduler {
  log.info({ cron: env.SCHEDULER_CRON }, "Starting scheduler");

  const checks = cron.schedule(env.SCHEDULER_CRON, async () => {
    log.info("Scheduler tick: checking for due users");
    try {
      await runScheduledChecks(bot, db, env, log);
    } catch (err) {
      log.error({ err }, "Scheduler error");
    }
  });

  const mobileStore = new MobileStore(db, env.ENCRYPTION_KEY);
  const mobileCleanup = cron.schedule("*/15 * * * *", async () => {
    try {
      const result = await mobileStore.cleanupExpiredData();
      if (result.artifactsDeleted > 0 || result.eventsDeleted > 0) {
        log.info(result, "Cleaned expired mobile data");
      }
    } catch (err) {
      log.error({ err }, "Mobile data cleanup failed");
    }
  });

  return {
    stop() {
      checks.stop();
      mobileCleanup.stop();
    },
  };
}
