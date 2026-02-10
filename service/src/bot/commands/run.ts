import { InlineKeyboard, InputFile } from "grammy";
import type { Bot } from "grammy";
import type { MyContext } from "../context.js";
import { getUserByTelegramId } from "../../db/users.js";
import {
  getActiveFamilyMembers,
  type DbFamilyMember,
} from "../../db/family-members.js";
import { insertRun, updateRunStatus } from "../../db/runs.js";
import { decrypt } from "../../crypto/encryption.js";
import { enqueue, getPosition } from "../../runner/queue.js";
import { executeRun } from "../../runner/evisa-runner.js";
import { MessageTracker } from "../../utils/messages.js";
import type { Credentials, AuthMethod, TwoFactorMethod, Purpose } from "evisa-flow";
import { readFile, unlink } from "node:fs/promises";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatValidUntil(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function buildCredentials(
  member: DbFamilyMember,
  encryptionKey: string,
): Credentials {
  const docNumber = decrypt(member.encrypted_doc_number, encryptionKey);
  let auth: AuthMethod;
  switch (member.auth_type) {
    case "passport":
      auth = { type: "passport", passportNumber: docNumber };
      break;
    case "nationalId":
      auth = { type: "nationalId", idNumber: docNumber };
      break;
    case "brc":
      auth = { type: "brc", cardNumber: docNumber };
      break;
    case "ukvi":
      auth = { type: "ukvi", customerNumber: docNumber };
      break;
    default:
      throw new Error(`Unknown auth type: ${member.auth_type}`);
  }
  return {
    auth,
    dateOfBirth: {
      day: member.dob_day,
      month: member.dob_month,
      year: member.dob_year,
    },
    preferredTwoFactorMethod: member.preferred_2fa_method as TwoFactorMethod,
  };
}

async function runForMember(
  ctx: MyContext,
  user: { id: string },
  member: DbFamilyMember,
  trigger: "manual" | "scheduled",
  tracker: MessageTracker,
): Promise<{ shareCode: string; validUntil?: Date } | null> {
  const runRecord = await insertRun(ctx.db, {
    user_id: user.id,
    family_member_id: member.id,
    trigger,
  });

  const statusMsg = await ctx.reply(
    `Running eVisa flow for <b>${escapeHtml(member.display_name)}</b>...\nProcessing`,
    { parse_mode: "HTML" },
  );
  tracker.track(statusMsg.message_id);

  const chatId = ctx.chat!.id;
  const startTime = Date.now();
  let progressPhase = "Processing";
  const progressTimer = setInterval(async () => {
    try {
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        `Running eVisa flow for <b>${escapeHtml(member.display_name)}</b>...\n${progressPhase} (${formatElapsed(Date.now() - startTime)})`,
        { parse_mode: "HTML" },
      );
    } catch {
      // Message may be gone or unchanged
    }
  }, 5000);

  await updateRunStatus(ctx.db, runRecord.id, { status: "running" });

  try {
    const credentials = buildCredentials(member, ctx.env.ENCRYPTION_KEY);
    const result = await executeRun({
      credentials,
      purpose: member.purpose as Purpose,
      outputDir: ctx.env.EVISA_OUTPUT_DIR,
      headless: ctx.env.EVISA_HEADLESS,
      telegramId: ctx.from!.id,
      memberName: member.display_name,
      onTwoFactorNeeded: async (method: TwoFactorMethod) => {
        progressPhase = "Waiting for 2FA";
        await updateRunStatus(ctx.db, runRecord.id, { status: "awaiting_2fa" });
        const promptMsg = await ctx.reply(
          [
            `<b>2FA Required — ${escapeHtml(member.display_name)}</b>`,
            "",
            `A code was sent via <b>${method.toUpperCase()}</b>.`,
            "Enter the code below:",
          ].join("\n"),
          { parse_mode: "HTML" },
        );
        tracker.track(promptMsg.message_id);
      },
    });

    clearInterval(progressTimer);

    await updateRunStatus(ctx.db, runRecord.id, {
      status: "success",
      share_code: result.shareCode,
      valid_until: result.validUntil?.toISOString(),
    });

    // Send PDF as Telegram document
    const validStr = result.validUntil
      ? `\nValid until: ${formatValidUntil(result.validUntil)}`
      : "";
    const caption = `${member.display_name} — ${result.shareCode}${validStr}`;

    try {
      const pdfData = await readFile(result.pdfPath);
      const filename = result.pdfPath.split("/").pop() ?? "evisa.pdf";
      await ctx.replyWithDocument(new InputFile(pdfData, filename), {
        caption,
      });
      await unlink(result.pdfPath).catch(() => {});
    } catch {
      // If PDF send fails, still show the share code as formatted text
      await ctx.reply(
        [
          `<b>${escapeHtml(member.display_name)}</b>`,
          "",
          `Share code:  <code>${escapeHtml(result.shareCode)}</code>`,
          validStr ? `Valid until:  ${formatValidUntil(result.validUntil!)}` : "",
        ].filter(Boolean).join("\n"),
        { parse_mode: "HTML" },
      );
    }

    return { shareCode: result.shareCode, validUntil: result.validUntil };
  } catch (err) {
    clearInterval(progressTimer);
    const message = err instanceof Error ? err.message : String(err);
    await updateRunStatus(ctx.db, runRecord.id, {
      status: "failed",
      error_message: message,
    });
    await ctx.reply(
      `Failed for <b>${escapeHtml(member.display_name)}</b>: ${escapeHtml(message)}`,
      { parse_mode: "HTML" },
    );
    return null;
  }
}

export async function runCommand(ctx: MyContext): Promise<void> {
  if (!ctx.from) return;

  const user = await getUserByTelegramId(ctx.db, ctx.from.id);
  if (!user) {
    await ctx.reply("Please /start first.");
    return;
  }

  const members = await getActiveFamilyMembers(ctx.db, user.id);
  if (members.length === 0) {
    await ctx.reply("No family members yet. Use /add to add one first.");
    return;
  }

  const kb = new InlineKeyboard();
  for (const m of members) {
    kb.text(m.display_name, `run_member:${m.id}`).row();
  }
  if (members.length > 1) {
    kb.text("Run All", "run_all").row();
  }
  kb.text("Cancel", "run_cancel").row();

  await ctx.reply(
    "<b>Get Share Codes</b>\n\nWho do you want to get a share code for?",
    { parse_mode: "HTML", reply_markup: kb },
  );
}

export function registerRunCallbacks(bot: Bot<MyContext>): void {
  async function confirmAndRun(
    ctx: MyContext,
    members: DbFamilyMember[],
    trigger: "manual" | "scheduled",
  ) {
    const user = await getUserByTelegramId(ctx.db, ctx.from!.id);
    if (!user) return;

    const tracker = new MessageTracker(ctx.chat!.id, ctx.api);
    const position = getPosition();

    let positionMsgId: number | undefined;
    if (position > 0) {
      const positionMsg = await ctx.reply(
        `<b>Queued</b>  —  Position #${position + 1}  (${position} run${position > 1 ? "s" : ""} ahead of you)`,
        { parse_mode: "HTML" },
      );
      positionMsgId = positionMsg.message_id;
      tracker.track(positionMsgId);
    }

    for (const member of members) {
      await enqueue(
        ctx.from!.id,
        member.display_name,
        async () => {
          await runForMember(ctx, user, member, trigger, tracker);
        },
        async (pos: number) => {
          if (!positionMsgId) return;
          try {
            if (pos === 0) {
              await ctx.api.editMessageText(
                ctx.chat!.id,
                positionMsgId,
                "Your turn! Starting...",
              );
            } else {
              await ctx.api.editMessageText(
                ctx.chat!.id,
                positionMsgId,
                `<b>Queued</b>  —  Position #${pos + 1}  (${pos} run${pos > 1 ? "s" : ""} ahead of you)`,
                { parse_mode: "HTML" },
              );
            }
          } catch {
            // Message may be gone
          }
        },
      );
    }

    await tracker.cleanup();

    if (members.length > 1) {
      const successCount = members.length; // TODO: track actual successes
      await ctx.reply(
        `<b>All done!</b>  ${successCount} member${successCount > 1 ? "s" : ""} processed.`,
        { parse_mode: "HTML" },
      );
    }
  }

  // Member selection
  bot.callbackQuery(/^run_member:/, async (ctx) => {
    const memberId = ctx.callbackQuery.data.replace("run_member:", "");
    const user = await getUserByTelegramId(ctx.db, ctx.from.id);
    if (!user) {
      await ctx.answerCallbackQuery({ text: "User not found." });
      return;
    }

    const members = await getActiveFamilyMembers(ctx.db, user.id);
    const member = members.find((m) => m.id === memberId);
    if (!member) {
      await ctx.answerCallbackQuery({ text: "Member not found." });
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `I'll need you to enter a 2FA code for <b>${escapeHtml(member.display_name)}</b>.\nHave their phone nearby. Ready?`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("Yes, let's go", `run_go:${memberId}`)
          .text("Cancel", "run_cancel"),
      },
    );
  });

  bot.callbackQuery(/^run_go:/, async (ctx) => {
    const memberId = ctx.callbackQuery.data.replace("run_go:", "");
    const user = await getUserByTelegramId(ctx.db, ctx.from.id);
    if (!user) return;

    const members = await getActiveFamilyMembers(ctx.db, user.id);
    const member = members.find((m) => m.id === memberId);
    if (!member) return;

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `Starting for <b>${escapeHtml(member.display_name)}</b>...`,
      { parse_mode: "HTML" },
    );
    await confirmAndRun(ctx, [member], "manual");
  });

  bot.callbackQuery("run_all", async (ctx) => {
    const user = await getUserByTelegramId(ctx.db, ctx.from.id);
    if (!user) return;

    const members = await getActiveFamilyMembers(ctx.db, user.id);
    if (members.length === 0) return;

    await ctx.answerCallbackQuery();
    const names = members.map((m) => escapeHtml(m.display_name)).join(", ");
    await ctx.editMessageText(
      [
        `I'll run for <b>${members.length}</b> member${members.length > 1 ? "s" : ""}: ${names}`,
        "",
        "You'll need to enter 2FA codes one at a time. Ready?",
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("Yes, let's go", "run_go_all")
          .text("Cancel", "run_cancel"),
      },
    );
  });

  bot.callbackQuery("run_go_all", async (ctx) => {
    const user = await getUserByTelegramId(ctx.db, ctx.from.id);
    if (!user) return;

    const members = await getActiveFamilyMembers(ctx.db, user.id);
    if (members.length === 0) return;

    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Starting...");
    await confirmAndRun(ctx, members, "manual");
  });

  bot.callbackQuery("run_cancel", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Cancelled." });
    await ctx.editMessageText("Cancelled.");
  });

  // Scheduled "I'm Ready" button
  bot.callbackQuery("schedule_ready", async (ctx) => {
    const user = await getUserByTelegramId(ctx.db, ctx.from.id);
    if (!user) return;

    const members = await getActiveFamilyMembers(ctx.db, user.id);
    if (members.length === 0) return;

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `Starting scheduled refresh for <b>${members.length}</b> member${members.length > 1 ? "s" : ""}...`,
      { parse_mode: "HTML" },
    );
    await confirmAndRun(ctx, members, "scheduled");
  });

  bot.callbackQuery("schedule_skip", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Skipped." });
    await ctx.editMessageText(
      "Skipped this time. I'll remind you again next cycle.",
    );
  });
}
