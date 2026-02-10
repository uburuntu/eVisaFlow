import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { MyContext } from "../bot/context.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { Logger } from "../utils/logger.js";
import {
  getUsersDueForSchedule,
  advanceSchedule,
} from "../db/users.js";
import { getActiveFamilyMembers } from "../db/family-members.js";

export async function runScheduledChecks(
  bot: Bot<MyContext>,
  db: SupabaseClient,
  env: Env,
  log: Logger,
): Promise<void> {
  const dueUsers = await getUsersDueForSchedule(db);
  log.info({ count: dueUsers.length }, "Users due for scheduled refresh");

  for (const user of dueUsers) {
    const members = await getActiveFamilyMembers(db, user.id);
    if (members.length === 0) {
      await advanceSchedule(db, user.id, env.SCHEDULE_INTERVAL_DAYS);
      continue;
    }

    const names = members.map((m) => m.display_name).join(", ");

    try {
      await bot.api.sendMessage(
        user.telegram_id,
        [
          "<b>Scheduled Share Code Refresh</b>",
          "",
          `${members.length} member${members.length > 1 ? "s" : ""}: ${names}`,
          "",
          "When you're ready with family phones nearby, tap below.",
        ].join("\n"),
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("I'm Ready", "schedule_ready")
            .text("Skip This Time", "schedule_skip"),
        },
      );

      await advanceSchedule(db, user.id, env.SCHEDULE_INTERVAL_DAYS);
    } catch (err) {
      log.warn(
        { err, telegramId: user.telegram_id },
        "Failed to send scheduled notification",
      );
      await advanceSchedule(db, user.id, env.SCHEDULE_INTERVAL_DAYS);
    }
  }
}
