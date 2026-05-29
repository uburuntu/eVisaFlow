import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Applicant,
  CreateShareCodeResult,
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
import type {
  EnqueueResult,
  EnqueueRunInput,
  RunEvent,
  RunSnapshot,
} from "./run-types.js";
import { SecretResolver } from "./secret-resolver.js";
import { resolveCode as defaultResolveCode } from "./two-factor-store.js";

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
