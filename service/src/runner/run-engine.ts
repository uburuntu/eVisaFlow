import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Applicant,
  CreateShareCodeResult,
  DiagnosticsMode,
  EVisaEvent,
  Purpose,
  TwoFactorMethod,
} from "evisa-flow";
import { createLogger, type Logger } from "../utils/logger.js";
import {
  enqueue as defaultEnqueue,
  getQueueStats,
  type EnqueueResult as QueueEnqueueResult,
} from "./queue.js";
import type { RunBus } from "./run-bus.js";
import { createInMemoryRunBus } from "./run-bus.js";
import { SecretResolver } from "./secret-resolver.js";
import { resolveCode as defaultResolveCode } from "./two-factor-store.js";

/** Who holds the key material that protects a member's secrets. */
export type RunCustody = "client" | "server";

/**
 * Per-run applicant input.
 *
 * - `inline`: client-custody. The browser-ready plaintext applicant is supplied
 *   directly (decrypted in the user's browser, sent over TLS per run). It is
 *   never persisted, never logged.
 * - `memberRef`: server-custody. The applicant is materialized server-side by
 *   decrypting the stored, AES-encrypted member record.
 */
export type RunApplicantInput =
  | {
      kind: "inline";
      applicant: Applicant;
      purpose: Purpose;
      twoFactorMethod?: TwoFactorMethod;
      memberName: string;
    }
  | { kind: "memberRef"; userId: string; familyMemberId: string };

export interface EnqueueRunInput {
  runId: string;
  ownerKey: string;
  custody: RunCustody;
  /** Required for client custody: outputs are sealed to this X25519 public key. */
  recipientPublicKey?: Uint8Array;
  applicant: RunApplicantInput;
  trigger: "manual" | "scheduled";
  headless: boolean;
  diagnosticsMode: DiagnosticsMode;
}

export type EnqueueResult =
  | { accepted: true; runId: string; position: number }
  | { accepted: false; runId: string; position: number; reason: string };

/** Opaque sealed bytes plus the algorithm that produced them. */
export interface SealedBlob {
  /** `aesgcm` for server custody, `box_seal` for client custody. */
  alg: "aesgcm" | "box_seal";
  /**
   * For `box_seal`: raw sealed bytes. For `aesgcm`: the encrypted string is
   * surfaced via {@link SealedBlob.cipher}; `bytes` is left undefined.
   */
  bytes?: Uint8Array;
  /** AES-GCM ciphertext string (server custody) when not byte-oriented. */
  cipher?: string;
}

/** A produced artifact, sealed for the recipient before it leaves the worker. */
export interface SealedArtifactRef {
  kind: "pdf" | "checker_html" | "checker_pdf";
  filename: string;
  contentType: string;
  byteLength: number;
  sealed: SealedBlob;
}

/**
 * The channel-agnostic event union the engine publishes. The engine is the
 * single place that translates the core lib's {@link EVisaEvent} into these.
 *
 * Server-custody runs (the trusted bot) may carry unsealed share codes/bytes;
 * client-custody runs always carry sealed forms only.
 */
export type RunEvent =
  | { type: "queued"; position: number; active: number }
  | { type: "started" }
  | { type: "phase"; phase: string; label: string }
  | {
      type: "timing";
      phase: string;
      operation: string;
      durationMs: number;
      stepId?: string;
    }
  | { type: "challenge_required"; method: TwoFactorMethod; deadlineMs: number }
  | { type: "artifact_ready"; artifact: SealedArtifactRef }
  | {
      type: "completed";
      validUntil?: string;
      sealedShareCode: SealedBlob;
      /** Present only for trusted server-custody runs. */
      shareCode?: string;
    }
  | { type: "failed"; code: string; message: string; terminal: boolean };

export type RunStatus = "queued" | "running" | "awaiting_2fa" | "completed" | "failed";

/** Latest derived state for a run, replayable to late subscribers. */
export interface RunSnapshot {
  runId: string;
  status: RunStatus;
  position?: number;
  active?: number;
  phase?: string;
  phaseLabel?: string;
  challengeMethod?: TwoFactorMethod;
  challengeDeadlineMs?: number;
  validUntil?: string;
  errorCode?: string;
  errorMessage?: string;
  lastEvent?: RunEvent;
}

/**
 * What a queued job receives. Tests inject a stub `runJob` so no Playwright is
 * launched; the real implementation will wrap {@link executeRun}.
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
  /** Optional DB handle for the server-custody secret resolver. */
  db?: SupabaseClient;
  /** Server AES key (hex) for server custody. Required for `memberRef` runs. */
  serverKeyHex?: string;
  enqueue?: typeof defaultEnqueue;
  resolveCode?: (runId: string, code: string) => boolean;
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
          await deps.runJob({
            input,
            applicant: resolved.applicant,
            purpose: resolved.purpose,
            twoFactorMethod: resolved.twoFactorMethod,
            memberName: resolved.memberName,
            signal,
            publish,
            log: log.child({ runId: input.runId, custody: input.custody }),
          });
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
