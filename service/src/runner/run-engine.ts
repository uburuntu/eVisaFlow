import type {
  Applicant,
  CreateShareCodeResult,
  EVisaEvent,
  HtmlResult,
  PdfResult,
  Purpose,
  TwoFactorMethod,
} from "evisa-flow";
import {
  type CustodyProvider,
  clientCustody as defaultClientCustody,
  serverCustody as defaultServerCustody,
} from "../crypto/custody.js";
import { ready as sealReady, toBase64 } from "../crypto/seal.js";
import type { Db } from "../db/client.js";
import {
  insertRunEvent as defaultInsertRunEvent,
  updateRunStatus as defaultUpdateRunStatus,
} from "../db/runs.js";
import { createLogger, type Logger } from "../utils/logger.js";
import type { ArtifactStore } from "./artifact-store.js";
import {
  enqueue as defaultEnqueue,
  getQueueStats,
  type EnqueueResult as QueueEnqueueResult,
  QueueJobCancelledError,
  type QueueTerminalStatus,
} from "./queue.js";
import type { RunBus } from "./run-bus.js";
import { createInMemoryRunBus } from "./run-bus.js";
import type {
  EnqueueResult,
  EnqueueRunInput,
  RunCustody,
  RunEvent,
  RunSnapshot,
  SealedArtifactRef,
} from "./run-types.js";
import { SecretResolver } from "./secret-resolver.js";
import { resolveCode as defaultResolveCode } from "./two-factor-store.js";

/**
 * Picks the {@link CustodyProvider} for a run from its {@link RunCustody}.
 *
 * - `server` (the trusted bot): AES-GCM with the server key. Requires
 *   `serverKeyHex`.
 * - `client` (the web app, E2EE): anonymous `crypto_box_seal` to the recipient's
 *   public key. Holds no server key.
 *
 * Injectable through {@link RunEngineDeps.selectCustody} so tests can stub the
 * crypto; the default wires the real {@link serverCustody}/{@link clientCustody}.
 */
export type SelectCustody = (
  custody: RunCustody,
  serverKeyHex: string | undefined
) => CustodyProvider;

const defaultSelectCustody: SelectCustody = (custody, serverKeyHex) => {
  if (custody === "server") {
    if (!serverKeyHex) {
      throw new Error("RunEngine: serverKeyHex is required for server custody");
    }
    return defaultServerCustody(serverKeyHex);
  }
  return defaultClientCustody();
};

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
  db?: Db;
  /** Server AES key (hex) for server custody. Required for `memberRef` runs. */
  serverKeyHex?: string;
  enqueue?: typeof defaultEnqueue;
  resolveCode?: (runId: string, code: string) => boolean;
  /**
   * Selects the {@link CustodyProvider} for a run from its custody. Defaults to
   * the real `serverCustody`/`clientCustody` wiring; injectable in tests.
   */
  selectCustody?: SelectCustody;
  /**
   * Persistence for sealed output artifacts, used ONLY for client custody: the
   * engine seals each artifact to the recipient's key and stores the sealed bytes
   * here for the web client to fetch and open later. Server-custody (bot) runs
   * never persist artifacts — they stream unsealed bytes straight to Telegram —
   * so this is unused for them. When absent, client artifacts are still published
   * as `artifact_ready` events but not stored.
   */
  artifactStore?: ArtifactStore;
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
 * Map a queue {@link QueueTerminalStatus} to the stable error `code` the bot's
 * `friendlyErrorMessage` understands. Cancellation must surface as `CANCELLED`
 * (→ "Cancelled for {memberName}.") and a shutdown interruption as
 * `SERVICE_INTERRUPTED`; using `UNKNOWN` would regress those user-facing
 * messages to the generic "Something went wrong" copy.
 */
function cancellationCode(status: QueueTerminalStatus): string {
  return status === "interrupted" ? "SERVICE_INTERRUPTED" : "CANCELLED";
}

/**
 * Build the terminal `failed` {@link RunEvent} for a cancelled/interrupted run.
 * It carries the bot-facing `code` (for the rendered message) and `cause` (the
 * terminal DB status the persistence subscriber records), keeping the two views
 * consistent so a cancel never lands in the DB as `failed`.
 */
function cancellationEvent(
  status: QueueTerminalStatus,
  message: string
): Extract<RunEvent, { type: "failed" }> {
  return {
    type: "failed",
    code: cancellationCode(status),
    message,
    terminal: true,
    cause: status,
  };
}

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
 * Custody-aware output handling. The {@link CustodyProvider} chosen from
 * `input.custody` decides how every output is protected before it leaves the
 * worker; the engine never branches on the algorithm beyond that one selection.
 *
 * - **server** (the trusted bot): AES-GCM with the server key. `completed`
 *   carries both the sealed (`aesgcm` cipher) form and the unsealed `shareCode`
 *   (allowed for the trusted bot); each `artifact_ready` carries the unsealed
 *   bytes for delivery.
 * - **client** (the web app, E2EE): anonymous `crypto_box_seal` to
 *   `recipientPublicKey`. `completed` carries ONLY the sealed share code — never
 *   a plaintext `shareCode`. Each `artifact_ready` carries `box_seal` bytes, and
 *   the sealed artifact is persisted via the {@link ArtifactStore} (sealed bytes
 *   only). No plaintext output ever leaves the worker for a client-custody run.
 *
 * INVARIANT: the plaintext `result.shareCode` is read only to seal it; for
 * client custody it is never published, persisted, or logged.
 */
async function publishOutputs(
  input: EnqueueRunInput,
  result: CreateShareCodeResult,
  publish: (event: RunEvent) => void,
  deps: {
    provider: CustodyProvider;
    artifactStore?: ArtifactStore;
    log: Logger;
  }
): Promise<void> {
  const isClient = input.custody === "client";
  // Client custody seals to the recipient's public key; without it we cannot
  // protect the outputs, so fail loudly rather than risk leaking plaintext.
  if (isClient && !input.recipientPublicKey) {
    throw new Error(
      "RunEngine: recipientPublicKey is required for client custody (cannot seal outputs)"
    );
  }
  const ctx = { recipientPublicKey: input.recipientPublicKey };

  // Publish artifacts BEFORE the terminal `completed` event. `completed` is a
  // terminal bus event: it flushes and ends every subscriber, so anything
  // published after it (including the DB-persistence subscriber and SSE
  // clients) would be dropped.
  for (const artifact of collectByteArtifacts(result)) {
    const sealed = deps.provider.sealArtifact(artifact.bytes, ctx);
    const ref: SealedArtifactRef = {
      kind: artifact.kind,
      filename: artifact.filename,
      contentType: artifact.contentType,
      byteLength: artifact.bytes.byteLength,
      sealed,
    };
    publish({ type: "artifact_ready", artifact: ref });
    // Persist the SEALED artifact (sealed bytes only) for CLIENT custody — this
    // is the E2EE delivery path: the web client fetches the sealed blob later and
    // opens it in-browser, and the store never sees plaintext. Server custody
    // (the trusted bot) keeps today's behavior: it streams the unsealed bytes
    // straight to Telegram via `artifact_ready` and persists nothing here.
    if (isClient && deps.artifactStore) {
      try {
        await deps.artifactStore.putSealed(input.runId, ref);
      } catch (err) {
        // Persistence is best-effort: a storage hiccup must not break the live
        // run. The sealed bytes were already delivered via `artifact_ready`.
        deps.log.warn(
          { err, runId: input.runId, kind: ref.kind },
          "Failed to persist sealed artifact"
        );
      }
    }
  }

  const sealedShareCode = deps.provider.sealShareCode(result.shareCode, ctx);
  publish({
    type: "completed",
    validUntil: result.validUntil,
    sealedShareCode,
    // The unsealed share code is included ONLY for the trusted server-custody
    // bot. Client custody must never publish plaintext: omit it entirely.
    ...(isClient ? {} : { shareCode: result.shareCode }),
  });
}

/**
 * Encodes a `completed` event's sealed share code for the `runs` row, deriving
 * the persisted `encrypted_share_code` text, its `share_code_alg`, and the
 * denormalized `custody` from the seal algorithm:
 *
 * - `aesgcm` (server custody): the AES ciphertext `cipher` string is stored as-is.
 * - `box_seal` (client custody): the sealed bytes are base64-encoded for the TEXT
 *   column — only the SEALED form is ever persisted, never plaintext.
 *
 * Returns `encrypted: undefined` when no sealed material is present (e.g. a run
 * with no share code), leaving `encrypted_share_code` untouched.
 */
function encodeSealedShareCode(blob: {
  alg: "aesgcm" | "box_seal";
  bytes?: Uint8Array;
  cipher?: string;
}): {
  encrypted: string | undefined;
  alg: "aesgcm" | "box_seal";
  custody: RunCustody;
} {
  if (blob.alg === "box_seal") {
    return {
      encrypted: blob.bytes ? toBase64(blob.bytes) : undefined,
      alg: "box_seal",
      custody: "client",
    };
  }
  return { encrypted: blob.cipher, alg: "aesgcm", custody: "server" };
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
    db: Db;
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
        case "completed": {
          // Persist the SEALED share code in the form matching its custody:
          // server custody stores the AES `cipher` string; client custody stores
          // the base64 of the `box_seal` bytes. The plaintext share code is
          // never written here (and `completed` never carries it for client
          // custody). Custody is derived from the seal algorithm.
          const sealed = encodeSealedShareCode(event.sealedShareCode);
          await deps.updateRunStatus(deps.db, runId, {
            status: "success",
            encrypted_share_code: sealed.encrypted,
            share_code_alg: sealed.alg,
            custody: sealed.custody,
            valid_until: event.validUntil,
          });
          break;
        }
        case "failed":
          // A cancelled/interrupted run carries `cause`; persist the matching
          // terminal status so run dedup sees it as cancelled/interrupted rather
          // than a generic failure. Plain failures default to "failed".
          await deps.updateRunStatus(deps.db, runId, {
            status: event.cause ?? "failed",
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
  const selectCustody = deps.selectCustody ?? defaultSelectCustody;
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
          // Select the custody provider and seal/encrypt outputs, then publish
          // completed + artifacts. Client custody seals via libsodium WASM, which
          // must be initialized before the synchronous seal calls; awaiting here
          // is a no-op once memoized.
          const provider = selectCustody(input.custody, deps.serverKeyHex);
          if (provider.custody === "client") {
            await sealReady();
          }
          await publishOutputs(input, runResult, publish, {
            provider,
            artifactStore: deps.artifactStore,
            log: runLog,
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
          // Surface terminal failures the job did not already publish (e.g. a
          // run cancelled while still queued never ran the job). A cancellation
          // must keep its terminal status: publishing `UNKNOWN` here would make
          // the bot render the generic error instead of "Cancelled for ...".
          const snapshot = bus.snapshot(input.runId);
          if (
            snapshot &&
            snapshot.status !== "failed" &&
            snapshot.status !== "completed"
          ) {
            publish(
              err instanceof QueueJobCancelledError
                ? cancellationEvent(err.terminalStatus, message)
                : { type: "failed", code: "UNKNOWN", message, terminal: true }
            );
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
      const status: QueueTerminalStatus = "cancelled";
      const cancelled = handle.cancel(reason, status);
      if (cancelled) {
        // The engine owns the terminal event so cancellation persists and
        // renders consistently. Publishing synchronously here makes this the
        // authoritative terminal event: it lands before the queue's async
        // rejection (and any core-lib `failed` event the job would emit on
        // abort), and the bus drops everything after it. The DB-persistence
        // subscriber then records `cancelled` (via `cause`), so callers must NOT
        // also write the run status themselves (that risks a `failed`/`cancelled`
        // write race).
        bus.publish(runId, cancellationEvent(status, reason));
      }
      return cancelled;
    },

    subscribe(runId) {
      return bus.subscribe(runId);
    },

    getSnapshot(runId) {
      return bus.snapshot(runId);
    },
  };
}
