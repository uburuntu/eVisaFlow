import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { MyContext } from "../bot/context.js";
import type { Db } from "../db/client.js";
import { getActiveFamilyMembers } from "../db/family-members.js";
import { advanceSchedule, getUsersDueForSchedule } from "../db/users.js";
import type { Env } from "../env.js";
import type { Logger } from "../utils/logger.js";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function runScheduledChecks(
  bot: Bot<MyContext>,
  db: Db,
  env: Env,
  log: Logger
): Promise<void> {
  const dueUsers = await getUsersDueForSchedule(db);
  log.info({ count: dueUsers.length }, "Users due for scheduled refresh");

  for (const user of dueUsers) {
    // Scheduled refreshes are delivered over Telegram, so skip web-only users
    // (telegram_id null since migration 004). Advance their schedule so they are
    // not re-selected every tick. Existing bot users always have a telegram_id,
    // so their behaviour is unchanged.
    if (user.telegram_id === null) {
      await advanceSchedule(db, user.id, env.SCHEDULE_INTERVAL_DAYS);
      continue;
    }
    const telegramId = user.telegram_id;

    const members = await getActiveFamilyMembers(db, user.id);
    if (members.length === 0) {
      await advanceSchedule(db, user.id, env.SCHEDULE_INTERVAL_DAYS);
      continue;
    }

    const names = members.map((m) => escapeHtml(m.display_name)).join(", ");

    try {
      await bot.api.sendMessage(
        telegramId,
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
            .text("I'm Ready", `schedule_ready:${telegramId}`)
            .text("Skip This Time", `schedule_skip:${telegramId}`),
        }
      );

      await advanceSchedule(db, user.id, env.SCHEDULE_INTERVAL_DAYS);
    } catch (err) {
      log.warn({ err, telegramId }, "Failed to send scheduled notification");
    }
  }
}
