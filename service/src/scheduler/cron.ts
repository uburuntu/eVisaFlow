import type { Bot } from "grammy";
import cron, { type ScheduledTask } from "node-cron";
import type { MyContext } from "../bot/context.js";
import type { Db } from "../db/client.js";
import type { Env } from "../env.js";
import type { Logger } from "../utils/logger.js";
import { runScheduledChecks } from "./scheduled-run.js";

export function startScheduler(
  bot: Bot<MyContext>,
  db: Db,
  env: Env,
  log: Logger
): ScheduledTask {
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
