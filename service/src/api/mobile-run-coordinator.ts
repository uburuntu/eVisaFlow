import type {
  CreateShareCodeResult,
  EVisaChallenge,
  EVisaChallengeContext,
  EVisaEvent,
} from "evisa-flow";
import type { MobileRunCreateRequest } from "evisa-flow/protocol";
import type { Env } from "../env.js";
import { executeRun } from "../runner/evisa-runner.js";
import { cancelJob, enqueue } from "../runner/queue.js";
import type { Logger } from "../utils/logger.js";
import {
  cancelMobileChallenge,
  requestMobileChallenge,
  submitMobileChallenge,
} from "./mobile-challenge-store.js";
import type { MobileStore } from "./mobile-store.js";

export class MobileRunCoordinator {
  constructor(
    private readonly store: MobileStore,
    private readonly env: Env,
    private readonly log: Logger
  ) {}

  start(userId: string, request: MobileRunCreateRequest): void {
    const runId = request.clientRunId;
    const queued = enqueue({
      id: runId,
      key: `mobile:${userId}:${request.profileId}`,
      ownerKey: `mobile:${userId}`,
      memberName: request.profileId,
      execute: (signal) => this.execute(userId, request, signal),
      onPositionUpdate: (position) =>
        this.store.appendEvent(runId, "queue_position", "launching", String(position)),
    });
    queued.handle.done.catch((error) => {
      this.log.warn(
        { err: error, runId, userId },
        "Mobile run queue job ended with error"
      );
    });
  }

  submitChallenge(userId: string, runId: string, code: string): boolean {
    return submitMobileChallenge({ userId, runId, code });
  }

  cancel(userId: string, runId: string): boolean {
    cancelMobileChallenge(runId, "Run cancelled by the user");
    const cancelled = cancelJob(runId, `Mobile user ${userId} cancelled the run`);
    return cancelled;
  }

  private async execute(
    userId: string,
    request: MobileRunCreateRequest,
    signal: AbortSignal
  ): Promise<void> {
    const runId = request.clientRunId;
    let eventWrites = Promise.resolve();
    try {
      await this.store.updateRun(runId, { status: "running", phase: "launching" });
      await this.store.appendEvent(runId, "run_started", "launching");

      const result = await executeRun({
        applicant: request.applicant,
        purpose: request.purpose,
        twoFactorMethod: request.preferredTwoFactorMethod,
        headless: this.env.EVISA_HEADLESS,
        diagnosticsMode: this.env.EVISA_DIAGNOSTICS_MODE,
        signal,
        onEvent: (event) => {
          eventWrites = eventWrites
            .then(() => this.persistEvent(runId, event))
            .catch((error) => {
              this.log.warn({ err: error, runId }, "Failed to persist mobile run event");
            });
        },
        onChallenge: (challenge, context) =>
          this.handleChallenge(userId, runId, challenge, context),
      });

      await eventWrites;
      await this.store.updateRun(runId, {
        status: "packaging",
        phase: "downloading_pdf",
      });
      await this.store.appendEvent(runId, "packaging", "downloading_pdf");
      const artifacts = collectArtifacts(result);
      await this.store.saveResult(
        runId,
        { shareCode: result.shareCode, validUntil: result.validUntil },
        artifacts
      );
      await this.store.appendEvent(runId, "completed", "completed");
    } catch (error) {
      const cancelled = signal.aborted;
      const code = cancelled ? "FLOW_CANCELLED" : errorCode(error);
      await this.store
        .updateRun(runId, {
          status: cancelled ? "cancelled" : "failed",
          phase: "failed",
          errorCode: code,
          retryable: !cancelled,
          clearRequest: true,
          challengeMethod: null,
          challengeDeadline: null,
        })
        .catch((updateError) => {
          this.log.warn(
            { err: updateError, runId },
            "Failed to store mobile run failure"
          );
        });
      await this.store.appendEvent(runId, "failed", "failed").catch(() => {});
      throw error;
    }
  }

  private async handleChallenge(
    userId: string,
    runId: string,
    challenge: EVisaChallenge,
    context: EVisaChallengeContext
  ): Promise<{ code: string }> {
    const deadline = new Date(context.deadlineMs).toISOString();
    await this.store.updateRun(runId, {
      status: "awaiting_2fa",
      phase: "waiting_for_2fa",
      challengeMethod: challenge.deliveryMethod,
      challengeDeadline: deadline,
    });
    await this.store.appendEvent(runId, "challenge_required", "waiting_for_2fa");
    const code = await requestMobileChallenge({
      userId,
      runId,
      method: challenge.deliveryMethod,
      deadlineMs: context.deadlineMs,
      signal: context.signal,
    });
    await this.store.updateRun(runId, {
      status: "running",
      challengeMethod: null,
      challengeDeadline: null,
    });
    await this.store.appendEvent(runId, "challenge_received", "waiting_for_2fa");
    return { code };
  }

  private async persistEvent(runId: string, event: EVisaEvent): Promise<void> {
    if (event.type === "phase_changed") {
      await this.store.updateRun(runId, { phase: event.phase });
    }
    await this.store.appendEvent(runId, event.type, event.phase);
  }
}

function collectArtifacts(result: CreateShareCodeResult) {
  const artifacts: Array<{
    kind: "evisa_pdf" | "checker_html" | "checker_pdf";
    filename: string;
    contentType: "application/pdf" | "text/html";
    bytes: Uint8Array;
  }> = [];
  if (result.pdf?.kind === "bytes") {
    artifacts.push({
      kind: "evisa_pdf",
      filename: result.pdf.filename,
      contentType: result.pdf.contentType,
      bytes: result.pdf.bytes,
    });
  }
  if (result.checker?.html?.kind === "bytes") {
    artifacts.push({
      kind: "checker_html",
      filename: result.checker.html.filename,
      contentType: result.checker.html.contentType,
      bytes: result.checker.html.bytes,
    });
  }
  if (result.checker?.pdf?.kind === "bytes") {
    artifacts.push({
      kind: "checker_pdf",
      filename: result.checker.pdf.filename,
      contentType: result.checker.pdf.contentType,
      bytes: result.checker.pdf.bytes,
    });
  }
  return artifacts;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = String(error.code);
    if (/^[A-Z0-9_]{1,80}$/.test(code)) return code;
  }
  return "RUN_FAILED";
}
