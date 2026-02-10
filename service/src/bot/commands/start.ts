import type { MyContext } from "../context.js";
import { upsertUser } from "../../db/users.js";

export async function startCommand(ctx: MyContext): Promise<void> {
  if (!ctx.from) return;

  const user = await upsertUser(
    ctx.db,
    ctx.from.id,
    ctx.from.first_name,
    ctx.from.username ?? null,
    ctx.env.SCHEDULE_INTERVAL_DAYS,
  );
  ctx.session.userId = user.id;

  await ctx.reply(
    [
      `<b>Welcome, ${escapeHtml(ctx.from.first_name)}!</b>`,
      "",
      "I help families retrieve UK eVisa share codes automatically.",
      "",
      "<b>How it works</b>",
      "1. Add family members with /add (up to 6)",
      "2. Run share code retrieval with /run",
      `3. I'll remind you every <b>${ctx.env.SCHEDULE_INTERVAL_DAYS} days</b> automatically`,
      "",
      "<b>Commands</b>",
      "/add — Add a family member",
      "/members — View or remove members",
      "/run — Get share codes",
      "/help — Show help",
      "",
      "Your document numbers are <b>encrypted at rest</b> and never stored in plain text.",
    ].join("\n"),
    { parse_mode: "HTML" },
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
