import type {
  Applicant,
  CreateShareCodeResult,
  EVisaChallenge,
  EVisaChallengeContext,
  EVisaErrorCode,
  EVisaEvent,
  EVisaPhase,
  Purpose,
  TwoFactorMethod,
} from "evisa-flow";
import { EVisaError } from "evisa-flow";
import type { Bot } from "grammy";
import { InlineKeyboard, InputFile, InputMediaBuilder } from "grammy";
import { decrypt, encrypt } from "../../crypto/encryption.js";
import { type DbFamilyMember, getActiveFamilyMembers } from "../../db/family-members.js";
import { type DbRun, insertRun, insertRunEvent, updateRunStatus } from "../../db/runs.js";
import { getUserByTelegramId } from "../../db/users.js";
import { executeRun } from "../../runner/evisa-runner.js";
import {
  cancelJob,
  enqueue,
  getJobInfo,
  getQueueStats,
  hasJob,
  QueueJobCancelledError,
} from "../../runner/queue.js";
import {
  cancelRequest,
  requestCode,
  setPromptMessageId,
} from "../../runner/two-factor-store.js";
import { escapeHtml, MessageTracker } from "../../utils/messages.js";
import type { MyContext } from "../context.js";

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

const phaseLabels: Record<EVisaPhase, string> = {
  launching: "Launching browser",
  verifying_identity: "Verifying identity",
  choosing_2fa: "Choosing 2FA method",
  waiting_for_2fa: "Waiting for 2FA",
  viewing_status: "Opening immigration status",
  creating_share_code: "Creating share code",
  downloading_pdf: "Downloading eVisa PDF",
  checking_status: "Opening checker status page",
  capturing_checker_html: "Capturing status check HTML page",
  downloading_checker_pdf: "Downloading status check PDF",
  completed: "Completed",
  failed: "Failed",
};

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

function abortReason(signal: AbortSignal): Error | undefined {
  if (!signal.aborted) {
    return undefined;
  }
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return new QueueJobCancelledError(
    typeof signal.reason === "string" ? signal.reason : "Run cancelled"
  );
}

function throwIfAborted(signal: AbortSignal): void {
  const reason = abortReason(signal);
  if (reason) {
    throw reason;
  }
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

function sanitizeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.split(/[?#]/, 1)[0] ?? value;
  }
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/https?:\/\/\S+/g, (value) => sanitizeUrl(value) ?? value)
    .slice(0, 500);
}

function queueCancellation(err: unknown): QueueJobCancelledError | undefined {
  if (err instanceof QueueJobCancelledError) {
    return err;
  }
  if (err instanceof Error && err.cause instanceof QueueJobCancelledError) {
    return err.cause;
  }
  return undefined;
}

function errorCode(err: unknown): string {
  const cancellation = queueCancellation(err);
  if (cancellation) {
    return cancellation.terminalStatus === "interrupted"
      ? "SERVICE_INTERRUPTED"
      : "CANCELLED";
  }
  if (err instanceof EVisaError) {
    return err.code;
  }
  return "UNKNOWN";
}

function friendlyErrorMessage(memberName: string, err: unknown): string {
  const cancellation = queueCancellation(err);
  if (cancellation) {
    return cancellation.terminalStatus === "interrupted"
      ? `Interrupted while processing ${memberName}. I will not keep waiting for a code.`
      : `Cancelled for ${memberName}.`;
  }

  const code = err instanceof EVisaError ? err.code : undefined;
  const messages: Partial<Record<EVisaErrorCode, string>> = {
    FLOW_CANCELLED: `Cancelled for ${memberName}.`,
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
    (code ? messages[code] : undefined) ??
    `Something went wrong for ${memberName}. The run was logged with code ${errorCode(err)}.`
  );
}

function eventRecord(event: EVisaEvent): {
  event_type: string;
  phase?: string;
  page_kind?: string;
  operation?: string;
  duration_ms?: number;
  step_id?: string;
  error_code?: string;
  message?: string;
  metadata?: Record<string, unknown>;
} {
  switch (event.type) {
    case "timing":
      return {
        event_type: event.type,
        phase: event.phase,
        page_kind: event.pageKind,
        operation: event.operation,
        duration_ms: event.durationMs,
        step_id: event.stepId,
        metadata: { url: sanitizeUrl(event.url) },
      };
    case "page_classified":
      return {
        event_type: event.type,
        phase: event.phase,
        page_kind: event.pageKind,
        metadata: {
          confidence: event.confidence,
          evidence: event.evidence.slice(0, 10),
        },
      };
    case "failed":
      return {
        event_type: event.type,
        phase: event.phase,
        error_code: event.error.code,
        message: sanitizeErrorMessage(event.error.message),
        metadata: {
          name: event.error.name,
          retryable: event.error.retryable,
        },
      };
    case "artifact_saved":
      return {
        event_type: event.type,
        phase: event.phase,
        metadata: {
          kind: event.artifact.kind,
          sanitized: event.artifact.sanitized,
        },
      };
    case "completed":
      return { event_type: event.type, phase: event.phase };
    case "challenge_required":
      return {
        event_type: event.type,
        phase: event.phase,
        metadata: {
          deliveryMethod: event.challenge.deliveryMethod,
          deadlineMs: event.challenge.deadlineMs,
        },
      };
    default:
      return { event_type: event.type, phase: event.phase };
  }
}

function persistRunEvent(ctx: MyContext, runId: string, event: EVisaEvent): void {
  const record = eventRecord(event);
  void insertRunEvent(ctx.db, {
    run_id: runId,
    ...record,
  }).catch((err) => {
    ctx.log.warn({ err, runId, eventType: event.type }, "Failed to persist run event");
  });
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
    signal: AbortSignal;
  }
): Promise<boolean> {
  throwIfAborted(params.signal);
  try {
    await ctx.replyWithDocument(
      new InputFile(Buffer.from(params.bytes), params.filename),
      { caption: params.caption }
    );
    throwIfAborted(params.signal);
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
    throwIfAborted(params.signal);
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
    signal: AbortSignal;
  }
): Promise<boolean> {
  throwIfAborted(params.signal);
  try {
    const media = params.artifacts.map((artifact, index) =>
      InputMediaBuilder.document(
        new InputFile(Buffer.from(artifact.bytes), artifact.filename),
        index === 0 ? { caption: params.caption } : undefined
      )
    );
    await ctx.replyWithMediaGroup(media);
    throwIfAborted(params.signal);
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
    throwIfAborted(params.signal);
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
  runId: string,
  signal: AbortSignal
): Promise<void> {
  for (const artifact of artifacts) {
    const sent = await sendBytesDocument(ctx, {
      member,
      label: artifact.label,
      filename: artifact.filename,
      bytes: artifact.bytes,
      caption: artifact.caption,
      runId,
      signal,
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
  runId: string,
  signal: AbortSignal
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

  throwIfAborted(signal);
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

  throwIfAborted(signal);
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
      signal,
    });
    if (sent) {
      return;
    }
  }

  await sendIndividualArtifacts(ctx, member, result, artifacts, runId, signal);
}

async function runForMember(params: {
  ctx: MyContext;
  user: { id: string };
  member: DbFamilyMember;
  trigger: "manual" | "scheduled";
  tracker: MessageTracker;
  runId: string;
  signal: AbortSignal;
}): Promise<CreateShareCodeResult | null> {
  const { ctx, user, member, trigger, tracker, runId, signal } = params;
  const chatId = ctx.chat?.id;
  const telegramId = ctx.from?.id;
  if (chatId === undefined || telegramId === undefined) {
    return null;
  }

  const log = ctx.log.child({
    runId,
    userId: user.id,
    familyMemberId: member.id,
    trigger,
  });
  const statusMsg = await ctx.reply(
    `Running eVisa flow for <b>${escapeHtml(member.display_name)}</b>...\nProcessing`,
    { parse_mode: "HTML", reply_markup: cancelKeyboard(runId) }
  );
  tracker.track(statusMsg.message_id);

  const startTime = Date.now();
  let progressPhase = "Processing";
  let lastTiming = "";
  const progressTimer = setInterval(async () => {
    try {
      const timingLine = lastTiming ? `\n${lastTiming}` : "";
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        `Running eVisa flow for <b>${escapeHtml(member.display_name)}</b>...\n${progressPhase} (${formatElapsed(Date.now() - startTime)})${timingLine}`,
        { parse_mode: "HTML", reply_markup: cancelKeyboard(runId) }
      );
    } catch {
      // Message may be gone or unchanged
    }
  }, 5000);

  try {
    await updateRunStatus(
      ctx.db,
      runId,
      { status: "running" },
      { throwOnConflict: true }
    );
    const applicant = buildApplicant(member, ctx.env.ENCRYPTION_KEY);
    const result = await executeRun({
      applicant,
      purpose: member.purpose as Purpose,
      twoFactorMethod: member.preferred_2fa_method as TwoFactorMethod,
      headless: ctx.env.EVISA_HEADLESS,
      diagnosticsMode: ctx.env.EVISA_DIAGNOSTICS_MODE,
      signal,
      onEvent: (event: EVisaEvent) => {
        persistRunEvent(ctx, runId, event);
        log.info({ event: eventRecord(event) }, "eVisa event");
        if (event.type === "phase_changed" || event.type === "page_classified") {
          progressPhase = phaseLabels[event.phase] ?? progressPhase;
          return;
        }

        if (event.type !== "timing") {
          return;
        }

        if (event.operation === "step" && event.stepId) {
          lastTiming = `Last step: ${escapeHtml(event.stepId)} ${Math.round(event.durationMs)}ms`;
        } else if (event.durationMs >= 1_000) {
          lastTiming = `Last ${escapeHtml(event.operation)}: ${Math.round(event.durationMs)}ms`;
        }
      },
      onChallenge: async (challenge: EVisaChallenge, context: EVisaChallengeContext) => {
        const codePromise = requestCode({
          requestId: runId,
          telegramId,
          chatId,
          method: challenge.deliveryMethod,
          memberName: member.display_name,
          deadlineMs: context.deadlineMs,
          signal: context.signal,
        });
        codePromise.catch(() => {});

        try {
          progressPhase = "Waiting for 2FA";
          await updateRunStatus(
            ctx.db,
            runId,
            { status: "awaiting_2fa" },
            { throwOnConflict: true }
          );
          const promptMsg = await ctx.reply(
            [
              `<b>2FA Required — ${escapeHtml(member.display_name)}</b>`,
              "",
              `A code was sent via <b>${challenge.deliveryMethod.toUpperCase()}</b>.`,
              "Reply with the code or send it as the next message.",
            ].join("\n"),
            { parse_mode: "HTML", reply_markup: cancelKeyboard(runId) }
          );
          tracker.track(promptMsg.message_id);
          setPromptMessageId(runId, promptMsg.message_id);
          return { code: await codePromise };
        } catch (error) {
          cancelRequest(runId, "2FA challenge failed");
          throw error;
        }
      },
    });

    throwIfAborted(signal);
    const markedSuccess = await updateRunStatus(ctx.db, runId, {
      status: "success",
      encrypted_share_code: encrypt(result.shareCode, ctx.env.ENCRYPTION_KEY),
      valid_until: result.validUntil,
    });
    if (!markedSuccess) {
      throw (
        abortReason(signal) ??
        new QueueJobCancelledError("Run is no longer active", "interrupted")
      );
    }

    await sendRunArtifacts(ctx, member, result, runId, signal);
    return result;
  } catch (err) {
    const code = errorCode(err);
    const cancellation = queueCancellation(err);
    const status = cancellation
      ? cancellation.terminalStatus
      : code === "FLOW_CANCELLED"
        ? "cancelled"
        : "failed";
    await updateRunStatus(ctx.db, runId, {
      status,
      error_code: code,
      error_message: sanitizeErrorMessage(
        err instanceof Error ? err.message : String(err)
      ),
    }).catch((updateError) => {
      log.warn({ err: updateError, status }, "Failed to update run terminal status");
    });
    log.warn(
      { err, code, status },
      status === "cancelled" ? "Run cancelled" : "Run failed"
    );
    await ctx.reply(friendlyErrorMessage(member.display_name, err));
    throw err;
  } finally {
    clearInterval(progressTimer);
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
    const handles: Array<ReturnType<typeof enqueue>["handle"]> = [];
    let successCount = 0;

    for (const member of members) {
      const key = `${telegramId}:${member.id}`;
      if (hasJob(key)) {
        await ctx.reply(
          `<b>${escapeHtml(member.display_name)}</b> is already queued or running.`,
          { parse_mode: "HTML" }
        );
        continue;
      }

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

      const result = enqueue({
        id: runRecord.id,
        key,
        ownerKey: String(telegramId),
        memberName: member.display_name,
        execute: async (signal) => {
          await runForMember({
            ctx,
            user,
            member,
            trigger,
            tracker,
            runId: runRecord.id,
            signal,
          });
          successCount += 1;
        },
        onPositionUpdate: async (pos: number) => {
          try {
            if (pos === 0) {
              await ctx.api.editMessageText(
                chatId,
                queueMsg.message_id,
                `<b>${escapeHtml(member.display_name)}</b> is starting now...`,
                { parse_mode: "HTML", reply_markup: cancelKeyboard(runRecord.id) }
              );
            } else {
              const stats = getQueueStats();
              await ctx.api.editMessageText(
                chatId,
                queueMsg.message_id,
                [
                  `<b>${escapeHtml(member.display_name)}</b> queued`,
                  `Position: #${pos}`,
                  `Active browser runs: ${stats.active}`,
                ].join("\n"),
                { parse_mode: "HTML", reply_markup: cancelKeyboard(runRecord.id) }
              );
            }
          } catch {
            // Message may be gone
          }
        },
      });

      if (!result.accepted) {
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

      handles.push(result.handle);
    }

    if (handles.length === 0) {
      await tracker.cleanup();
      return;
    }

    void Promise.allSettled(handles.map((handle) => handle.done))
      .then(async () => {
        await tracker.cleanup();
        if (members.length > 1) {
          await ctx.api.sendMessage(
            chatId,
            `<b>All done!</b> ${successCount}/${handles.length} run${handles.length > 1 ? "s" : ""} completed successfully.`,
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
    if (String(ctx.from?.id) !== job.ownerKey) {
      await ctx.answerCallbackQuery({ text: "This run belongs to another user." });
      return;
    }

    const cancelled = cancelJob(runId);
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
