import type {
  Applicant,
  CreateShareCodeResult,
  Purpose,
  TwoFactorMethod,
} from "evisa-flow";
import type { Bot } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import { decrypt } from "../../crypto/encryption.js";
import { type DbFamilyMember, getActiveFamilyMembers } from "../../db/family-members.js";
import { insertRun, updateRunStatus } from "../../db/runs.js";
import { getUserByTelegramId } from "../../db/users.js";
import { executeRun } from "../../runner/evisa-runner.js";
import { enqueue, getPosition } from "../../runner/queue.js";
import { MessageTracker } from "../../utils/messages.js";
import type { MyContext } from "../context.js";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatValidUntil(date: string): string {
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function buildApplicant(member: DbFamilyMember, encryptionKey: string): Applicant {
  const docNumber = decrypt(member.encrypted_doc_number, encryptionKey);
  if (
    member.auth_type !== "passport" &&
    member.auth_type !== "nationalId" &&
    member.auth_type !== "brc" &&
    member.auth_type !== "ukvi"
  ) {
    throw new Error(`Unknown auth type: ${member.auth_type}`);
  }

  return {
    identityDocument: {
      type: member.auth_type,
      number: docNumber,
    },
    dateOfBirth: `${String(member.dob_year).padStart(4, "0")}-${String(member.dob_month).padStart(2, "0")}-${String(member.dob_day).padStart(2, "0")}`,
  };
}

async function runForMember(
  ctx: MyContext,
  user: { id: string },
  member: DbFamilyMember,
  trigger: "manual" | "scheduled",
  tracker: MessageTracker
): Promise<CreateShareCodeResult | null> {
  const chatId = ctx.chat?.id;
  const telegramId = ctx.from?.id;
  if (chatId === undefined || telegramId === undefined) {
    return null;
  }

  const runRecord = await insertRun(ctx.db, {
    user_id: user.id,
    family_member_id: member.id,
    trigger,
  });

  const statusMsg = await ctx.reply(
    `Running eVisa flow for <b>${escapeHtml(member.display_name)}</b>...\nProcessing`,
    { parse_mode: "HTML" }
  );
  tracker.track(statusMsg.message_id);

  const startTime = Date.now();
  let progressPhase = "Processing";
  const progressTimer = setInterval(async () => {
    try {
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        `Running eVisa flow for <b>${escapeHtml(member.display_name)}</b>...\n${progressPhase} (${formatElapsed(Date.now() - startTime)})`,
        { parse_mode: "HTML" }
      );
    } catch {
      // Message may be gone or unchanged
    }
  }, 5000);

  await updateRunStatus(ctx.db, runRecord.id, { status: "running" });

  try {
    const applicant = buildApplicant(member, ctx.env.ENCRYPTION_KEY);
    const result = await executeRun({
      requestId: runRecord.id,
      applicant,
      purpose: member.purpose as Purpose,
      twoFactorMethod: member.preferred_2fa_method as TwoFactorMethod,
      headless: ctx.env.EVISA_HEADLESS,
      telegramId,
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
          { parse_mode: "HTML" }
        );
        tracker.track(promptMsg.message_id);
      },
    });

    clearInterval(progressTimer);

    await updateRunStatus(ctx.db, runRecord.id, {
      status: "success",
      share_code: result.shareCode,
      valid_until: result.validUntil,
    });

    // Send PDF as Telegram document
    const validStr = result.validUntil
      ? `\nValid until: ${formatValidUntil(result.validUntil)}`
      : "";
    const caption = `${member.display_name} — ${result.shareCode}${validStr}`;

    try {
      if (result.pdf?.kind !== "bytes") {
        throw new Error("PDF bytes were not produced");
      }
      await ctx.replyWithDocument(
        new InputFile(Buffer.from(result.pdf.bytes), result.pdf.filename),
        {
          caption,
        }
      );
    } catch {
      // If PDF send fails, still show the share code as formatted text
      await ctx.reply(
        [
          `<b>${escapeHtml(member.display_name)}</b>`,
          "",
          `Share code:  <code>${escapeHtml(result.shareCode)}</code>`,
          result.validUntil ? `Valid until:  ${formatValidUntil(result.validUntil)}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        { parse_mode: "HTML" }
      );
    }

    return result;
  } catch (err) {
    clearInterval(progressTimer);
    const message = err instanceof Error ? err.message : String(err);
    await updateRunStatus(ctx.db, runRecord.id, {
      status: "failed",
      error_message: message,
    });
    await ctx.reply(
      `Failed for <b>${escapeHtml(member.display_name)}</b>: ${escapeHtml(message)}`,
      { parse_mode: "HTML" }
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

  await ctx.reply("<b>Get Share Codes</b>\n\nWho do you want to get a share code for?", {
    parse_mode: "HTML",
    reply_markup: kb,
  });
}

export function registerRunCallbacks(bot: Bot<MyContext>): void {
  async function confirmAndRun(
    ctx: MyContext,
    members: DbFamilyMember[],
    trigger: "manual" | "scheduled"
  ) {
    const telegramId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (telegramId === undefined || chatId === undefined) {
      return;
    }

    const user = await getUserByTelegramId(ctx.db, telegramId);
    if (!user) return;

    const tracker = new MessageTracker(chatId, ctx.api);
    const position = getPosition();
    let successCount = 0;

    let positionMsgId: number | undefined;
    if (position > 0) {
      const positionMsg = await ctx.reply(
        `<b>Queued</b>  —  Position #${position + 1}  (${position} run${position > 1 ? "s" : ""} ahead of you)`,
        { parse_mode: "HTML" }
      );
      positionMsgId = positionMsg.message_id;
      tracker.track(positionMsgId);
    }

    for (const member of members) {
      await enqueue(
        telegramId,
        member.display_name,
        async () => {
          const result = await runForMember(ctx, user, member, trigger, tracker);
          if (result) {
            successCount += 1;
          }
        },
        async (pos: number) => {
          if (!positionMsgId) return;
          try {
            if (pos === 0) {
              await ctx.api.editMessageText(
                chatId,
                positionMsgId,
                "Your turn! Starting..."
              );
            } else {
              await ctx.api.editMessageText(
                chatId,
                positionMsgId,
                `<b>Queued</b>  —  Position #${pos + 1}  (${pos} run${pos > 1 ? "s" : ""} ahead of you)`,
                { parse_mode: "HTML" }
              );
            }
          } catch {
            // Message may be gone
          }
        }
      );
    }

    await tracker.cleanup();

    if (members.length > 1) {
      await ctx.reply(
        `<b>All done!</b>  ${successCount} member${successCount > 1 ? "s" : ""} processed.`,
        { parse_mode: "HTML" }
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
      }
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
      { parse_mode: "HTML" }
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
      }
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
      { parse_mode: "HTML" }
    );
    await confirmAndRun(ctx, members, "scheduled");
  });

  bot.callbackQuery("schedule_skip", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Skipped." });
    await ctx.editMessageText("Skipped this time. I'll remind you again next cycle.");
  });
}
