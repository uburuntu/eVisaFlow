import cron from "node-cron";
import type { Bot } from "grammy";
import type { MyContext } from "../bot/context.js";
import { runScheduledChecks } from "./scheduled-run.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { Logger } from "../utils/logger.js";

export function startScheduler(
  bot: Bot<MyContext>,
  db: SupabaseClient,
  env: Env,
  log: Logger,
): cron.ScheduledTask {
  log.info({ cron: env.SCHEDULER_CRON }, "Starting scheduler");

  return cron.schedule(env.SCHEDULER_CRON, async () => {
    log.info("Scheduler tick: checking for due users");
    try {
      await runScheduledChecks(bot, db, env, log);
    } catch (err) {
      log.error({ err }, "Scheduler error");
    }
  });
}
