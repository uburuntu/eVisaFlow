import { InlineKeyboard } from "grammy";
import type { MyContext } from "../context.js";
import { getUserByTelegramId } from "../../db/users.js";
import {
  getActiveFamilyMembers,
  deactivateFamilyMember,
} from "../../db/family-members.js";

const TYPE_LABELS: Record<string, string> = {
  passport: "Passport",
  nationalId: "National ID",
  brc: "BRC",
  ukvi: "UKVI",
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function membersCommand(ctx: MyContext): Promise<void> {
  if (!ctx.from) return;

  const user = await getUserByTelegramId(ctx.db, ctx.from.id);
  if (!user) {
    await ctx.reply("Please /start first.");
    return;
  }

  const members = await getActiveFamilyMembers(ctx.db, user.id);
  if (members.length === 0) {
    await ctx.reply(
      "No family members yet. Use /add to add one.",
    );
    return;
  }

  const lines = members.map((m, i) => {
    const typeLabel = TYPE_LABELS[m.auth_type] ?? m.auth_type;
    const dob = `${String(m.dob_day).padStart(2, "0")}-${String(m.dob_month).padStart(2, "0")}-${m.dob_year}`;
    return `${i + 1}. <b>${escapeHtml(m.display_name)}</b>  —  ${typeLabel}  —  ${dob}  —  ${m.preferred_2fa_method.toUpperCase()}`;
  });

  const kb = new InlineKeyboard();
  for (const m of members) {
    kb.text(`Remove ${m.display_name}`, `rm_member:${m.id}`).row();
  }

  await ctx.reply(
    [
      `<b>Family Members</b>  (${members.length}/6)`,
      "",
      ...lines,
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: kb },
  );
}

export function registerMemberCallbacks(bot: import("grammy").Bot<MyContext>): void {
  bot.callbackQuery(/^rm_member:/, async (ctx) => {
    const memberId = ctx.callbackQuery.data.replace("rm_member:", "");

    const user = await getUserByTelegramId(ctx.db, ctx.from.id);
    if (!user) {
      await ctx.answerCallbackQuery({ text: "User not found." });
      return;
    }

    await deactivateFamilyMember(ctx.db, memberId, user.id);
    await ctx.answerCallbackQuery({ text: "Removed." });
    await ctx.editMessageText(
      "Member removed. Use /members to see the updated list.",
    );
  });
}
