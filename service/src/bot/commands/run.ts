import type {
  CreateShareCodeResult,
  EVisaErrorCode,
  HtmlResult,
  PdfResult,
} from "evisa-flow";
import type { Bot } from "grammy";
import { InlineKeyboard, InputFile, InputMediaBuilder } from "grammy";
import { type DbFamilyMember, getActiveFamilyMembers } from "../../db/family-members.js";
import { type DbRun, insertRun, updateRunStatus } from "../../db/runs.js";
import { getUserByTelegramId } from "../../db/users.js";
import { getJobInfo } from "../../runner/queue.js";
import type { RunEvent, SealedArtifactRef } from "../../runner/run-types.js";
import { bindTelegramRoute } from "../../runner/two-factor-store.js";
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

function cancelKeyboard(runId: string): InlineKeyboard {
  return new InlineKeyboard().text("Cancel", `cancel_run:${runId}`);
}

function scopedCallback(action: string, telegramId: number, value?: string): string {
  return value === undefined
    ? `${action}:${telegramId}`
    : `${action}:${telegramId}:${value}`;
}

async function requireCallbackOwner(
  ctx: MyContext,
  ownerTelegramId: string
): Promise<boolean> {
  if (String(ctx.from?.id) === ownerTelegramId) {
    return true;
  }
  await ctx.answerCallbackQuery({ text: "This button belongs to another user." });
  return false;
}

function friendlyErrorMessage(memberName: string, code: string): string {
  if (code === "SERVICE_INTERRUPTED") {
    return `Interrupted while processing ${memberName}. I will not keep waiting for a code.`;
  }
  if (code === "FLOW_CANCELLED" || code === "CANCELLED") {
    return `Cancelled for ${memberName}.`;
  }

  const messages: Partial<Record<EVisaErrorCode, string>> = {
    TWO_FACTOR_TIMEOUT: `I did not receive the security code for ${memberName} in time. Run it again when the phone or email is nearby.`,
    AUTHENTICATION_FAILED: `GOV.UK rejected the saved details for ${memberName}. Check the document number, date of birth, and document type in /members.`,
    SESSION_EXPIRED: `The GOV.UK session expired for ${memberName}. Please run it again.`,
    SERVICE_UNAVAILABLE: "GOV.UK is unavailable right now. Please try again later.",
    BROWSER_LAUNCH_FAILED:
      "The browser could not start on the server. Check the deployment or Playwright install.",
    PAGE_DETECTION_FAILED:
      "GOV.UK showed an unexpected page. I saved diagnostics for debugging where configured.",
    SELECTOR_NOT_FOUND:
      "GOV.UK changed or loaded differently than expected. I saved diagnostics for debugging where configured.",
    CONFIG_INVALID:
      "The saved configuration is invalid. Check the member details and service environment.",
  };

  return (
    messages[code as EVisaErrorCode] ??
    `Something went wrong for ${memberName}. The run was logged with code ${code}.`
  );
}

async function sendBytesDocument(
  ctx: MyContext,
  params: {
    member: DbFamilyMember;
    label: string;
    filename: string;
    bytes: Uint8Array;
    caption: string;
    runId: string;
  }
): Promise<boolean> {
  try {
    await ctx.replyWithDocument(
      new InputFile(Buffer.from(params.bytes), params.filename),
      { caption: params.caption }
    );
    ctx.log.info(
      {
        runId: params.runId,
        artifact: params.label,
        bytes: params.bytes.byteLength,
      },
      "Sent artifact"
    );
    return true;
  } catch (err) {
    ctx.log.warn(
      { err, runId: params.runId, artifact: params.label },
      "Failed to send artifact"
    );
    await ctx.reply(
      [
        `<b>${escapeHtml(params.member.display_name)}</b>`,
        `${escapeHtml(params.label)} could not be uploaded to Telegram.`,
        "The share code result is still valid if it was sent above.",
      ].join("\n"),
      { parse_mode: "HTML" }
    );
    return false;
  }
}

interface BytesDocumentArtifact {
  label: string;
  filename: string;
  bytes: Uint8Array;
  caption: string;
}

async function sendBytesDocumentGroup(
  ctx: MyContext,
  params: {
    artifacts: BytesDocumentArtifact[];
    caption: string;
    runId: string;
  }
): Promise<boolean> {
  try {
    const media = params.artifacts.map((artifact, index) =>
      InputMediaBuilder.document(
        new InputFile(Buffer.from(artifact.bytes), artifact.filename),
        index === 0 ? { caption: params.caption } : undefined
      )
    );
    await ctx.replyWithMediaGroup(media);
    ctx.log.info(
      {
        runId: params.runId,
        artifacts: params.artifacts.map((artifact) => artifact.label),
        bytes: params.artifacts.reduce(
          (total, artifact) => total + artifact.bytes.byteLength,
          0
        ),
      },
      "Sent artifact media group"
    );
    return true;
  } catch (err) {
    ctx.log.warn(
      { err, runId: params.runId, artifacts: params.artifacts.map((a) => a.label) },
      "Failed to send artifact media group"
    );
    return false;
  }
}

async function sendIndividualArtifacts(
  ctx: MyContext,
  member: DbFamilyMember,
  result: CreateShareCodeResult,
  artifacts: BytesDocumentArtifact[],
  runId: string
): Promise<void> {
  for (const artifact of artifacts) {
    const sent = await sendBytesDocument(ctx, {
      member,
      label: artifact.label,
      filename: artifact.filename,
      bytes: artifact.bytes,
      caption: artifact.caption,
      runId,
    });
    if (!sent && artifact.label === "eVisa PDF") {
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
  }
}

async function sendRunArtifacts(
  ctx: MyContext,
  member: DbFamilyMember,
  result: CreateShareCodeResult,
  runId: string
): Promise<void> {
  const validStr = result.validUntil
    ? `\nValid until: ${formatValidUntil(result.validUntil)}`
    : "";
  const caption = `${member.display_name} — ${result.shareCode}${validStr}`;
  const artifacts: BytesDocumentArtifact[] = [];

  if (result.pdf?.kind === "bytes") {
    artifacts.push({
      label: "eVisa PDF",
      filename: result.pdf.filename,
      bytes: result.pdf.bytes,
      caption,
    });
  } else {
    await ctx.reply(
      [
        `<b>${escapeHtml(member.display_name)}</b>`,
        "",
        `Share code:  <code>${escapeHtml(result.shareCode)}</code>`,
        result.validUntil ? `Valid until:  ${formatValidUntil(result.validUntil)}` : "",
        "",
        "The eVisa PDF was not produced by the browser flow.",
      ]
        .filter(Boolean)
        .join("\n"),
      { parse_mode: "HTML" }
    );
  }

  if (result.checker?.html?.kind === "bytes") {
    artifacts.push({
      label: "status check HTML",
      filename: result.checker.html.filename,
      bytes: result.checker.html.bytes,
      caption: `${member.display_name} — status check page HTML`,
    });
  } else {
    await ctx.reply(
      `${escapeHtml(member.display_name)} — status check HTML was not produced.`,
      { parse_mode: "HTML" }
    );
  }

  if (result.checker?.pdf?.kind === "bytes") {
    artifacts.push({
      label: "status check PDF",
      filename: result.checker.pdf.filename,
      bytes: result.checker.pdf.bytes,
      caption: `${member.display_name} — status check PDF`,
    });
  } else {
    await ctx.reply(
      `${escapeHtml(member.display_name)} — status check PDF was not produced.`,
      { parse_mode: "HTML" }
    );
  }

  if (artifacts.length === 0) {
    return;
  }

  if (artifacts.length >= 2) {
    const sent = await sendBytesDocumentGroup(ctx, {
      artifacts,
      caption,
      runId,
    });
    if (sent) {
      return;
    }
  }

  await sendIndividualArtifacts(ctx, member, result, artifacts, runId);
}

/**
 * Rebuild the {@link CreateShareCodeResult} shape `sendRunArtifacts` expects from
 * the engine's terminal events: the share code/validity come from `completed`
 * (the trusted server-custody bot receives the unsealed share code) and the
 * byte artifacts from the `artifact_ready` events collected during the run.
 *
 * Only artifacts the engine actually emitted are populated; missing kinds stay
 * undefined so `sendRunArtifacts` reports them as "not produced" exactly as the
 * inline orchestration did.
 */
function resultFromEvents(
  completed: Extract<RunEvent, { type: "completed" }>,
  artifacts: Map<SealedArtifactRef["kind"], SealedArtifactRef>
): CreateShareCodeResult {
  const pdfRef = artifacts.get("pdf");
  const pdf: PdfResult | undefined =
    pdfRef?.sealed.bytes !== undefined
      ? {
          kind: "bytes",
          bytes: pdfRef.sealed.bytes,
          filename: pdfRef.filename,
          contentType: "application/pdf",
          byteLength: pdfRef.byteLength,
        }
      : undefined;

  const htmlRef = artifacts.get("checker_html");
  const html: HtmlResult | undefined =
    htmlRef?.sealed.bytes !== undefined
      ? {
          kind: "bytes",
          bytes: htmlRef.sealed.bytes,
          filename: htmlRef.filename,
          contentType: "text/html",
          byteLength: htmlRef.byteLength,
          standalone: true,
        }
      : undefined;

  const checkerPdfRef = artifacts.get("checker_pdf");
  const checkerPdf: PdfResult | undefined =
    checkerPdfRef?.sealed.bytes !== undefined
      ? {
          kind: "bytes",
          bytes: checkerPdfRef.sealed.bytes,
          filename: checkerPdfRef.filename,
          contentType: "application/pdf",
          byteLength: checkerPdfRef.byteLength,
        }
      : undefined;

  const shareCode = completed.shareCode ?? "";
  return {
    shareCode,
    validUntil: completed.validUntil,
    pdf,
    checker: html || checkerPdf ? { shareCode, html, pdf: checkerPdf } : undefined,
  };
}

/**
 * Drives the Telegram UI for one run by subscribing to the engine's event
 * stream. The engine owns applicant resolution, the queue slot, output sealing,
 * status transitions, and event persistence; this only renders progress, sends
 * the 2FA prompt, and delivers artifacts. Resolves with the run's
 * {@link CreateShareCodeResult} on success, or `null` otherwise.
 */
async function driveRun(params: {
  ctx: MyContext;
  member: DbFamilyMember;
  runId: string;
  queueMessageId: number;
  tracker: MessageTracker;
}): Promise<CreateShareCodeResult | null> {
  const { ctx, member, runId, queueMessageId, tracker } = params;
  const chatId = ctx.chat?.id;
  const telegramId = ctx.from?.id;
  if (chatId === undefined || telegramId === undefined) {
    return null;
  }

  const startTime = Date.now();
  let progressPhase = "Processing";
  let lastTiming = "";
  let statusMessageId: number | undefined;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  const collectedArtifacts = new Map<SealedArtifactRef["kind"], SealedArtifactRef>();
  let result: CreateShareCodeResult | null = null;

  const renderStatus = async (): Promise<void> => {
    if (statusMessageId === undefined) {
      return;
    }
    try {
      const timingLine = lastTiming ? `\n${lastTiming}` : "";
      await ctx.api.editMessageText(
        chatId,
        statusMessageId,
        `Running eVisa flow for <b>${escapeHtml(member.display_name)}</b>...\n${progressPhase} (${formatElapsed(Date.now() - startTime)})${timingLine}`,
        { parse_mode: "HTML", reply_markup: cancelKeyboard(runId) }
      );
    } catch {
      // Message may be gone or unchanged
    }
  };

  const startRunningStatus = async (): Promise<void> => {
    if (statusMessageId !== undefined) {
      return;
    }
    try {
      await ctx.api.editMessageText(
        chatId,
        queueMessageId,
        `<b>${escapeHtml(member.display_name)}</b> is starting now...`,
        { parse_mode: "HTML", reply_markup: cancelKeyboard(runId) }
      );
    } catch {
      // Message may be gone
    }
    const statusMsg = await ctx.reply(
      `Running eVisa flow for <b>${escapeHtml(member.display_name)}</b>...\nProcessing`,
      { parse_mode: "HTML", reply_markup: cancelKeyboard(runId) }
    );
    statusMessageId = statusMsg.message_id;
    tracker.track(statusMessageId);
    progressTimer = setInterval(() => {
      void renderStatus();
    }, 5000);
  };

  try {
    for await (const ev of ctx.engine.subscribe(runId)) {
      switch (ev.type) {
        case "queued":
          try {
            await ctx.api.editMessageText(
              chatId,
              queueMessageId,
              [
                `<b>${escapeHtml(member.display_name)}</b> queued`,
                `Position: #${ev.position}`,
                `Active browser runs: ${ev.active}`,
              ].join("\n"),
              { parse_mode: "HTML", reply_markup: cancelKeyboard(runId) }
            );
          } catch {
            // Message may be gone
          }
          break;
        case "started":
          await startRunningStatus();
          break;
        case "phase":
          await startRunningStatus();
          progressPhase = ev.label;
          break;
        case "timing":
          if (ev.operation === "step" && ev.stepId) {
            lastTiming = `Last step: ${escapeHtml(ev.stepId)} ${Math.round(ev.durationMs)}ms`;
          } else if (ev.durationMs >= 1_000) {
            lastTiming = `Last ${escapeHtml(ev.operation)}: ${Math.round(ev.durationMs)}ms`;
          }
          break;
        case "challenge_required": {
          progressPhase = "Waiting for 2FA";
          const promptMsg = await ctx.reply(
            [
              `<b>2FA Required — ${escapeHtml(member.display_name)}</b>`,
              "",
              `A code was sent via <b>${ev.method.toUpperCase()}</b>.`,
              "Reply with the code or send it as the next message.",
            ].join("\n"),
            { parse_mode: "HTML", reply_markup: cancelKeyboard(runId) }
          );
          tracker.track(promptMsg.message_id);
          // Bind the Telegram delivery context so the reply-matching middleware
          // can route the user's code back to this run's pending 2FA request.
          bindTelegramRoute(runId, {
            telegramId,
            chatId,
            promptMessageId: promptMsg.message_id,
          });
          break;
        }
        case "artifact_ready":
          collectedArtifacts.set(ev.artifact.kind, ev.artifact);
          break;
        case "completed":
          result = resultFromEvents(ev, collectedArtifacts);
          await sendRunArtifacts(ctx, member, result, runId);
          break;
        case "failed":
          await ctx.reply(friendlyErrorMessage(member.display_name, ev.code));
          break;
        default:
          break;
      }
    }
  } finally {
    if (progressTimer) {
      clearInterval(progressTimer);
    }
  }

  return result;
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
    kb.text(m.display_name, scopedCallback("run_member", ctx.from.id, m.id)).row();
  }
  if (members.length > 1) {
    kb.text("Run All", scopedCallback("run_all", ctx.from.id)).row();
  }
  kb.text("Cancel", scopedCallback("run_cancel", ctx.from.id)).row();

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
    const drivers: Array<Promise<CreateShareCodeResult | null>> = [];

    for (const member of members) {
      // Dedup is enforced by the partial unique index
      // `idx_runs_one_active_per_member`: a second non-terminal run for the same
      // member makes `insertRun` throw, which we surface as "already queued".
      let runRecord: DbRun;
      try {
        runRecord = await insertRun(ctx.db, {
          user_id: user.id,
          family_member_id: member.id,
          trigger,
        });
      } catch (err) {
        ctx.log.warn({ err, memberId: member.id }, "Failed to insert run");
        await ctx.reply(
          `<b>${escapeHtml(member.display_name)}</b> is already queued or running.`,
          { parse_mode: "HTML" }
        );
        continue;
      }

      const queueMsg = await ctx.reply(
        `<b>${escapeHtml(member.display_name)}</b> queued...`,
        { parse_mode: "HTML", reply_markup: cancelKeyboard(runRecord.id) }
      );
      tracker.track(queueMsg.message_id);

      const enqueueResult = ctx.engine.enqueueRun({
        runId: runRecord.id,
        ownerKey: String(telegramId),
        custody: "server",
        applicant: {
          kind: "memberRef",
          userId: user.id,
          familyMemberId: member.id,
        },
        trigger,
        headless: ctx.env.EVISA_HEADLESS,
        diagnosticsMode: ctx.env.EVISA_DIAGNOSTICS_MODE,
      });

      if (!enqueueResult.accepted) {
        await updateRunStatus(ctx.db, runRecord.id, {
          status: "cancelled",
          error_code: "DUPLICATE_RUN",
          error_message: "Duplicate queued run",
        });
        await ctx.reply(
          `<b>${escapeHtml(member.display_name)}</b> is already queued or running.`,
          { parse_mode: "HTML" }
        );
        continue;
      }

      drivers.push(
        driveRun({
          ctx,
          member,
          runId: runRecord.id,
          queueMessageId: queueMsg.message_id,
          tracker,
        })
      );
    }

    if (drivers.length === 0) {
      await tracker.cleanup();
      return;
    }

    void Promise.allSettled(drivers)
      .then(async (outcomes) => {
        await tracker.cleanup();
        if (members.length > 1) {
          const successCount = outcomes.filter(
            (outcome) => outcome.status === "fulfilled" && outcome.value !== null
          ).length;
          await ctx.api.sendMessage(
            chatId,
            `<b>All done!</b> ${successCount}/${drivers.length} run${drivers.length > 1 ? "s" : ""} completed successfully.`,
            { parse_mode: "HTML" }
          );
        }
      })
      .catch((err) => {
        ctx.log.warn({ err }, "Failed to send batch completion message");
      });
  }

  bot.callbackQuery(/^cancel_run:/, async (ctx) => {
    const runId = ctx.callbackQuery.data.replace("cancel_run:", "");
    const job = getJobInfo(runId);
    if (!job) {
      await ctx.answerCallbackQuery({ text: "This run is no longer active." });
      return;
    }
    if (ctx.from?.id !== job.telegramId) {
      await ctx.answerCallbackQuery({ text: "This run belongs to another user." });
      return;
    }

    const cancelled = ctx.engine.cancel(runId, "Cancelled by user");
    if (cancelled) {
      await updateRunStatus(ctx.db, runId, {
        status: "cancelled",
        error_code: "CANCELLED",
        error_message: "Cancelled by user",
      }).catch(() => {});
    }
    await ctx.answerCallbackQuery({
      text: cancelled ? "Cancelling..." : "Already done.",
    });
    await ctx.editMessageText(cancelled ? "Cancelling..." : "Run is no longer active.");
  });

  bot.callbackQuery(/^run_member:(\d+):(.+)$/, async (ctx) => {
    const [, ownerTelegramId, memberId] = ctx.match;
    if (!(await requireCallbackOwner(ctx, ownerTelegramId))) {
      return;
    }
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
          .text("Yes, let's go", scopedCallback("run_go", ctx.from.id, memberId))
          .text("Cancel", scopedCallback("run_cancel", ctx.from.id)),
      }
    );
  });

  bot.callbackQuery(/^run_go:(\d+):(.+)$/, async (ctx) => {
    const [, ownerTelegramId, memberId] = ctx.match;
    if (!(await requireCallbackOwner(ctx, ownerTelegramId))) {
      return;
    }
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

  bot.callbackQuery(/^run_all:(\d+)$/, async (ctx) => {
    const [, ownerTelegramId] = ctx.match;
    if (!(await requireCallbackOwner(ctx, ownerTelegramId))) {
      return;
    }
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
          .text("Yes, let's go", scopedCallback("run_go_all", ctx.from.id))
          .text("Cancel", scopedCallback("run_cancel", ctx.from.id)),
      }
    );
  });

  bot.callbackQuery(/^run_go_all:(\d+)$/, async (ctx) => {
    const [, ownerTelegramId] = ctx.match;
    if (!(await requireCallbackOwner(ctx, ownerTelegramId))) {
      return;
    }
    const user = await getUserByTelegramId(ctx.db, ctx.from.id);
    if (!user) return;

    const members = await getActiveFamilyMembers(ctx.db, user.id);
    if (members.length === 0) return;

    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Queued. I will process one member at a time.");
    await confirmAndRun(ctx, members, "manual");
  });

  bot.callbackQuery(/^run_cancel:(\d+)$/, async (ctx) => {
    const [, ownerTelegramId] = ctx.match;
    if (!(await requireCallbackOwner(ctx, ownerTelegramId))) {
      return;
    }
    await ctx.answerCallbackQuery({ text: "Cancelled." });
    await ctx.editMessageText("Cancelled.");
  });

  bot.callbackQuery(/^schedule_ready:(\d+)$/, async (ctx) => {
    const [, ownerTelegramId] = ctx.match;
    if (!(await requireCallbackOwner(ctx, ownerTelegramId))) {
      return;
    }
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

  bot.callbackQuery(/^schedule_skip:(\d+)$/, async (ctx) => {
    const [, ownerTelegramId] = ctx.match;
    if (!(await requireCallbackOwner(ctx, ownerTelegramId))) {
      return;
    }
    await ctx.answerCallbackQuery({ text: "Skipped." });
    await ctx.editMessageText("Skipped this time. I'll remind you again next cycle.");
  });
}
