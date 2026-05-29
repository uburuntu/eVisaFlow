import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Applicant,
  CreateShareCodeResult,
  EVisaEvent,
  HtmlResult,
  PdfResult,
  Purpose,
  TwoFactorMethod,
} from "evisa-flow";
import { encrypt as defaultEncrypt } from "../crypto/encryption.js";
import {
  insertRunEvent as defaultInsertRunEvent,
  updateRunStatus as defaultUpdateRunStatus,
} from "../db/runs.js";
import { createLogger, type Logger } from "../utils/logger.js";
import {
  enqueue as defaultEnqueue,
  getQueueStats,
  type EnqueueResult as QueueEnqueueResult,
} from "./queue.js";
import type { RunBus } from "./run-bus.js";
import { createInMemoryRunBus } from "./run-bus.js";
import type {
  EnqueueResult,
  EnqueueRunInput,
  RunEvent,
  RunSnapshot,
  SealedArtifactRef,
} from "./run-types.js";
import { SecretResolver } from "./secret-resolver.js";
import { resolveCode as defaultResolveCode } from "./two-factor-store.js";

/**
 * What a queued job receives. Tests inject a stub `runJob` so no Playwright is
 * launched; the real implementation ({@link createEvisaRunJob}) drives the core
 * eVisa flow.
 */
export interface RunJobContext {
  input: EnqueueRunInput;
  applicant: Applicant;
  purpose: Purpose;
  twoFactorMethod?: TwoFactorMethod;
  memberName: string;
  signal: AbortSignal;
  /** Publish a translated {@link RunEvent} for this run. */
  publish: (event: RunEvent) => void;
  log: Logger;
}

export type RunJob = (
  context: RunJobContext
) => Promise<CreateShareCodeResult | undefined>;

export interface RunEngineDeps {
  /** The unit of work executed inside the queue slot. Stubbed in tests. */
  runJob: RunJob;
  bus?: RunBus;
  /**
   * Optional DB handle. When provided, the engine starts an internal
   * persistence subscriber per run that maps {@link RunEvent}s to the
   * `db/runs` helpers. The same handle backs the server-custody resolver.
   */
  db?: SupabaseClient;
  /** Server AES key (hex) for server custody. Required for `memberRef` runs. */
  serverKeyHex?: string;
  enqueue?: typeof defaultEnqueue;
  resolveCode?: (runId: string, code: string) => boolean;
  /** Injectable AES-GCM encrypt (server custody share-code sealing). */
  encrypt?: typeof defaultEncrypt;
  /** Injectable for tests; defaults to the real DB writer. */
  updateRunStatus?: typeof defaultUpdateRunStatus;
  /** Injectable for tests; defaults to the real DB writer. */
  insertRunEvent?: typeof defaultInsertRunEvent;
  logger?: Logger;
}

const phaseLabels: Record<string, string> = {
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

/**
 * Translate a single core-library {@link EVisaEvent} into the engine's
 * {@link RunEvent} union. `completed` is intentionally not translated here:
 * the job seals/encrypts outputs per custody before publishing `completed`.
 */
export function translateEVisaEvent(event: EVisaEvent): RunEvent | undefined {
  switch (event.type) {
    case "run_started":
      return { type: "started" };
    case "phase_changed":
    case "page_classified":
      return {
        type: "phase",
        phase: event.phase,
        label: phaseLabels[event.phase] ?? event.phase,
      };
    case "timing":
      return {
        type: "timing",
        phase: event.phase,
        operation: event.operation,
        durationMs: event.durationMs,
        stepId: event.stepId,
      };
    case "challenge_required":
      return {
        type: "challenge_required",
        method: event.challenge.deliveryMethod,
        deadlineMs: event.challenge.deadlineMs,
      };
    case "completed":
      // Handled by the job after sealing; do not forward raw results.
      return undefined;
    case "failed":
      return {
        type: "failed",
        code: event.error.code ?? event.error.name,
        message: event.error.message,
        terminal: true,
      };
    default:
      return undefined;
  }
}

/**
 * Collect the byte-oriented artifacts a completed run produced (eVisa PDF,
 * checker HTML, checker PDF), in the order the bot renders them. Only artifacts
 * captured in `bytes` mode are forwarded; `file`-mode results are skipped (the
 * worker streams in-memory bytes to channels).
 */
function collectByteArtifacts(result: CreateShareCodeResult): Array<{
  kind: SealedArtifactRef["kind"];
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}> {
  const artifacts: Array<{
    kind: SealedArtifactRef["kind"];
    bytes: Uint8Array;
    filename: string;
    contentType: string;
  }> = [];
  const pdf: PdfResult | undefined = result.pdf;
  if (pdf?.kind === "bytes") {
    artifacts.push({
      kind: "pdf",
      bytes: pdf.bytes,
      filename: pdf.filename,
      contentType: pdf.contentType,
    });
  }
  const html: HtmlResult | undefined = result.checker?.html;
  if (html?.kind === "bytes") {
    artifacts.push({
      kind: "checker_html",
      bytes: html.bytes,
      filename: html.filename,
      contentType: html.contentType,
    });
  }
  const checkerPdf: PdfResult | undefined = result.checker?.pdf;
  if (checkerPdf?.kind === "bytes") {
    artifacts.push({
      kind: "checker_pdf",
      bytes: checkerPdf.bytes,
      filename: checkerPdf.filename,
      contentType: checkerPdf.contentType,
    });
  }
  return artifacts;
}

/**
 * Server-custody output handling: AES-encrypt the share code with the server
 * key, publish a `completed` event carrying both the sealed form and the
 * unsealed share code (allowed for the trusted bot), then publish one
 * `artifact_ready` per produced artifact carrying the unsealed bytes for the
 * bot to deliver.
 *
 * Client-custody sealing (`crypto_box_seal` to `recipientPublicKey`) lands in
 * Phase 3; see the explicitly marked branch below.
 */
function publishOutputs(
  input: EnqueueRunInput,
  result: CreateShareCodeResult,
  publish: (event: RunEvent) => void,
  encrypt: typeof defaultEncrypt,
  serverKeyHex: string | undefined,
  log: Logger
): void {
  if (input.custody === "client") {
    // TODO(Phase 3): seal the share code and each artifact to
    // `input.recipientPublicKey` via crypto_box_seal and publish the sealed
    // forms only (no plaintext share code, no unsealed bytes). Until then,
    // client-custody output handling is intentionally not implemented.
    log.warn(
      { custody: "client" },
      "Client-custody output sealing is not implemented yet (Phase 3)"
    );
    throw new Error("Client-custody output sealing is not implemented yet");
  }

  // Server custody (the trusted bot): AES-encrypt the share code.
  if (!serverKeyHex) {
    throw new Error("RunEngine: serverKeyHex is required for server custody");
  }
  const cipher = encrypt(result.shareCode, serverKeyHex);

  // Publish artifacts BEFORE the terminal `completed` event. `completed` is a
  // terminal bus event: it flushes and ends every subscriber, so anything
  // published after it (including the DB-persistence subscriber and SSE
  // clients) would be dropped.
  for (const artifact of collectByteArtifacts(result)) {
    publish({
      type: "artifact_ready",
      artifact: {
        kind: artifact.kind,
        filename: artifact.filename,
        contentType: artifact.contentType,
        byteLength: artifact.bytes.byteLength,
        // Server custody: carry the unsealed bytes for the trusted bot.
        sealed: { alg: "aesgcm", bytes: artifact.bytes },
      },
    });
  }

  publish({
    type: "completed",
    validUntil: result.validUntil,
    sealedShareCode: { alg: "aesgcm", cipher },
    // Unsealed share code is allowed for the trusted server-custody bot.
    shareCode: result.shareCode,
  });
}

/**
 * Internal per-run DB-persistence subscriber. Consumes the run bus and maps the
 * channel-agnostic {@link RunEvent}s to the existing `db/runs` helpers:
 * status transitions via `updateRunStatus` and a timeline row via
 * `insertRunEvent`. It NEVER writes applicant doc#/DOB into any event or log.
 */
async function persistRunEvents(
  runId: string,
  events: AsyncIterable<RunEvent>,
  deps: {
    db: SupabaseClient;
    updateRunStatus: typeof defaultUpdateRunStatus;
    insertRunEvent: typeof defaultInsertRunEvent;
    log: Logger;
  }
): Promise<void> {
  for await (const event of events) {
    try {
      switch (event.type) {
        case "started":
          await deps.updateRunStatus(deps.db, runId, { status: "running" });
          break;
        case "challenge_required":
          await deps.updateRunStatus(deps.db, runId, { status: "awaiting_2fa" });
          break;
        case "completed":
          await deps.updateRunStatus(deps.db, runId, {
            status: "success",
            encrypted_share_code: event.sealedShareCode.cipher,
            valid_until: event.validUntil,
          });
          break;
        case "failed":
          await deps.updateRunStatus(deps.db, runId, {
            status: "failed",
            error_code: event.code,
            error_message: event.message,
          });
          break;
        default:
          break;
      }
      await deps.insertRunEvent(deps.db, runEventRecord(runId, event));
    } catch (err) {
      // Persistence is best-effort: a DB hiccup must not break the live run.
      deps.log.warn({ err, runId, eventType: event.type }, "Failed to persist run event");
    }
  }
}

/** Map a {@link RunEvent} to the `insertRunEvent` row shape (no secrets). */
function runEventRecord(
  runId: string,
  event: RunEvent
): Parameters<typeof defaultInsertRunEvent>[1] {
  switch (event.type) {
    case "queued":
      return {
        run_id: runId,
        event_type: "queued",
        metadata: { position: event.position, active: event.active },
      };
    case "phase":
      return { run_id: runId, event_type: "phase", phase: event.phase };
    case "timing":
      return {
        run_id: runId,
        event_type: "timing",
        phase: event.phase,
        operation: event.operation,
        duration_ms: event.durationMs,
        step_id: event.stepId,
      };
    case "challenge_required":
      return {
        run_id: runId,
        event_type: "challenge_required",
        phase: "waiting_for_2fa",
        metadata: { deliveryMethod: event.method, deadlineMs: event.deadlineMs },
      };
    case "artifact_ready":
      return {
        run_id: runId,
        event_type: "artifact_ready",
        metadata: {
          kind: event.artifact.kind,
          byteLength: event.artifact.byteLength,
        },
      };
    case "completed":
      return {
        run_id: runId,
        event_type: "completed",
        phase: "completed",
        metadata: { validUntil: event.validUntil },
      };
    case "failed":
      return {
        run_id: runId,
        event_type: "failed",
        phase: "failed",
        error_code: event.code,
        message: event.message,
      };
    default:
      return { run_id: runId, event_type: (event as RunEvent).type };
  }
}

export interface RunEngine {
  enqueueRun(input: EnqueueRunInput): EnqueueResult;
  submitCode(runId: string, code: string): boolean;
  cancel(runId: string, reason?: string): boolean;
  subscribe(runId: string): AsyncIterable<RunEvent>;
  getSnapshot(runId: string): RunSnapshot | undefined;
}

export function createRunEngine(deps: RunEngineDeps): RunEngine {
  const bus = deps.bus ?? createInMemoryRunBus();
  const enqueue = deps.enqueue ?? defaultEnqueue;
  const resolveCode = deps.resolveCode ?? defaultResolveCode;
  const encrypt = deps.encrypt ?? defaultEncrypt;
  const updateRunStatus = deps.updateRunStatus ?? defaultUpdateRunStatus;
  const insertRunEvent = deps.insertRunEvent ?? defaultInsertRunEvent;
  const log = deps.logger ?? createLogger();
  const handles = new Map<string, QueueEnqueueResult["handle"]>();

  function memberName(input: EnqueueRunInput): string {
    return input.applicant.kind === "inline"
      ? input.applicant.memberName
      : input.applicant.familyMemberId;
  }

  return {
    enqueueRun(input) {
      const publish = (event: RunEvent) => bus.publish(input.runId, event);
      const result = enqueue({
        id: input.runId,
        key: `${input.ownerKey}:${input.runId}`,
        ownerKey: input.ownerKey,
        memberName: memberName(input),
        execute: async (signal) => {
          // Resolve plaintext into a local const; never persist or log it.
          const resolved = await SecretResolver.resolve(input.applicant, {
            db: deps.db,
            serverKeyHex: deps.serverKeyHex,
            log,
          });
          publish({ type: "started" });
          const runLog = log.child({ runId: input.runId, custody: input.custody });
          const runResult = await deps.runJob({
            input,
            applicant: resolved.applicant,
            purpose: resolved.purpose,
            twoFactorMethod: resolved.twoFactorMethod,
            memberName: resolved.memberName,
            signal,
            publish,
            log: runLog,
          });
          if (!runResult) {
            // No result (e.g. a stub job that publishes its own terminal event).
            return;
          }
          // Seal/encrypt outputs per custody, then publish completed + artifacts.
          publishOutputs(input, runResult, publish, encrypt, deps.serverKeyHex, runLog);
        },
        onPositionUpdate: (position) => {
          if (position > 0) {
            const stats = getQueueStats();
            publish({ type: "queued", position, active: stats.active });
          }
        },
      });

      if (!result.accepted) {
        return {
          accepted: false,
          runId: input.runId,
          position: result.position,
          reason: "duplicate",
        };
      }

      // Start the internal DB-persistence subscriber only for an accepted run
      // (after the duplicate check) so a rejected duplicate does not spin up a
      // second consumer that would double-persist the same topic. It subscribes
      // before the job emits anything, replaying the backlog and capturing every
      // transition. Best-effort: its failures are logged, never surfaced.
      if (deps.db) {
        void persistRunEvents(input.runId, bus.subscribe(input.runId), {
          db: deps.db,
          updateRunStatus,
          insertRunEvent,
          log,
        });
      }

      handles.set(input.runId, result.handle);
      // Seed an initial `queued` snapshot when the job starts in a waiting slot
      // (e.g. blocked behind a busy same-owner run). `onPositionUpdate` does not
      // fire for the initial position until another job advances the queue.
      if (result.position > 0) {
        publish({
          type: "queued",
          position: result.position,
          active: getQueueStats().active,
        });
      }
      result.handle.done
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          // Surface terminal failures the job did not already publish.
          const snapshot = bus.snapshot(input.runId);
          if (
            snapshot &&
            snapshot.status !== "failed" &&
            snapshot.status !== "completed"
          ) {
            publish({
              type: "failed",
              code: "UNKNOWN",
              message,
              terminal: true,
            });
          }
        })
        .finally(() => {
          handles.delete(input.runId);
        });

      return { accepted: true, runId: input.runId, position: result.position };
    },

    submitCode(runId, code) {
      return resolveCode(runId, code);
    },

    cancel(runId, reason = "Run cancelled") {
      const handle = handles.get(runId);
      if (!handle) {
        return false;
      }
      return handle.cancel(reason);
    },

    subscribe(runId) {
      return bus.subscribe(runId);
    },

    getSnapshot(runId) {
      return bus.snapshot(runId);
    },
  };
}
