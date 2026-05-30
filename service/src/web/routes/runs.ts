import type { Applicant, Purpose, TwoFactorMethod } from "evisa-flow";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { makeRequireUser } from "../../auth/session.js";
import { fromBase64 } from "../../crypto/seal.js";
import type { Db } from "../../db/client.js";
import { getFamilyMemberById } from "../../db/family-members.js";
import { type DbRun, getRunById, insertRun, listRunsForUser } from "../../db/runs.js";
import { getVault } from "../../db/user-vault.js";
import type { Env } from "../../env.js";
import type { ArtifactStore, StoredArtifact } from "../../runner/artifact-store.js";
import type { RunEngine } from "../../runner/run-engine.js";
import type { RunEvent } from "../../runner/run-types.js";
import type { Logger } from "../../utils/logger.js";
import type { EntitlementService } from "../entitlements.js";
import type { WebFastifyInstance } from "../server.js";
import { streamRunEvents, streamTerminalRunEvent } from "../sse.js";

/**
 * Run lifecycle routes for the E2EE web app: create a run from an inline,
 * client-decrypted applicant; stream its progress over SSE; submit the 2FA code;
 * cancel; fetch the SEALED output artifacts; and list run history.
 *
 * SECURITY (non-negotiable):
 * - The inline plaintext applicant on POST /api/runs is decrypted in the user's
 *   browser and sent per-run over TLS. It is NEVER logged here and NEVER
 *   persisted (the engine resolves it into a local const for the run's lifetime
 *   only). This route must not log `request.body`.
 * - Every per-run route authorizes ownership via `runs.user_id`: the run id in
 *   the URL must belong to the session user, else 404 (indistinguishable from a
 *   missing run — no signal that another user's run exists).
 * - Artifacts stream as OPAQUE sealed bytes (`application/octet-stream`); the
 *   client opens them in-browser with its private key. The server holds no key
 *   for client-custody data.
 */

export interface RunRoutesDeps {
  db: Db;
  engine: RunEngine;
  entitlements: EntitlementService;
  artifactStore: ArtifactStore;
  env: Env;
  log: Logger;
}

/** Browser-decrypted applicant identity document (one of four UK doc types). */
const identityDocumentSchema = z.object({
  type: z.enum(["passport", "nationalId", "brc", "ukvi"]),
  number: z.string().trim().min(1).max(100),
});

/**
 * Date of birth as the core lib accepts it: either an ISO `YYYY-MM-DD` string or
 * a `{day,month,year}` triple. Kept permissive on shape (the core flow validates
 * deeply); we only bound sizes so the body stays small.
 */
const dateOfBirthSchema = z.union([
  z.string().trim().min(1).max(40),
  z.object({
    day: z.number().int().min(1).max(31),
    month: z.number().int().min(1).max(12),
    year: z.number().int().min(1900).max(2100),
  }),
]);

const applicantSchema = z.object({
  identityDocument: identityDocumentSchema,
  dateOfBirth: dateOfBirthSchema,
});

const createRunBodySchema = z.object({
  // The member the run is for — its display name is used for status messages and
  // ownership is verified before enqueue. The applicant secret itself is NOT read
  // from the member (that is the sealed blob); it arrives inline below.
  memberId: z.string().trim().min(1),
  // Inline, browser-decrypted applicant. Plaintext in transit only; never stored.
  applicant: applicantSchema,
  purpose: z.enum(["right_to_work", "right_to_rent", "immigration_status_other"]),
  twoFactorMethod: z.enum(["sms", "email"]).optional(),
});

const submitCodeBodySchema = z.object({
  // The 2FA code the user received. Trimmed; bounded to a sane length. Never
  // logged (it is a transient credential for the in-flight run).
  code: z.string().trim().min(1).max(32),
});

/** Public, secret-free shape of a stored artifact for the listing endpoint. */
interface ArtifactListItem {
  id: string;
  kind: string | null;
  byteLength: number | null;
  sealedAlg: string | null;
  createdAt: string;
  expiresAt: string;
}

function toArtifactListItem(a: StoredArtifact): ArtifactListItem {
  return {
    id: a.id,
    kind: a.kind,
    byteLength: a.byteLength,
    sealedAlg: a.sealedAlg,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
  };
}

/** The owner key the engine namespaces a web run by: `user:<uuid>`. */
function ownerKeyFor(userId: string): string {
  return `user:${userId}`;
}

/**
 * Whether an error is a Postgres unique-violation (SQLSTATE 23505). Drizzle wraps
 * driver errors in a `DrizzleQueryError`, so the pg `code` lands on `err.cause`;
 * check both the error and its cause so this works regardless of wrapping. Used to
 * map the `idx_runs_one_active_per_member` collision to a 409 "already active".
 */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  const causeCode = (err as { cause?: { code?: string } })?.cause?.code;
  return code === "23505" || causeCode === "23505";
}

/** DB statuses that mean the run is finished and will publish no more events. */
const TERMINAL_DB_STATUSES = new Set(["success", "failed", "cancelled", "interrupted"]);

/**
 * Reconstructs the terminal {@link RunEvent} for an already-finished run from its
 * persisted row, so a client that connects (or reconnects) AFTER the in-memory
 * bus topic has been torn down still learns the final state instead of hanging on
 * a dead, never-ending subscription.
 *
 * - `success` → `completed`, rebuilding `sealedShareCode` from the stored
 *   `encrypted_share_code` + `share_code_alg` (only the SEALED form is persisted;
 *   client custody stores base64 `box_seal` bytes, server custody an `aesgcm`
 *   `cipher` string). The plaintext share code is never stored, so it is never
 *   present here. `share_code_alg` defaults to `box_seal` (web runs are always
 *   client custody); a run with no share code yields a `completed` with no sealed
 *   payload.
 * - `failed`/`cancelled`/`interrupted` → `failed`, carrying the persisted
 *   `error_code`/`error_message` and the `cause` for cancelled/interrupted.
 *
 * Returns null for a non-terminal run (the caller then subscribes live instead).
 */
function terminalEventForRun(run: DbRun): RunEvent | null {
  if (!TERMINAL_DB_STATUSES.has(run.status)) return null;
  if (run.status === "success") {
    const alg: "aesgcm" | "box_seal" =
      run.share_code_alg === "aesgcm" ? "aesgcm" : "box_seal";
    const sealedShareCode =
      run.encrypted_share_code === null
        ? // No share code persisted: surface a completed with an empty sealed blob
          // of the run's algorithm (the client treats a missing payload as "none").
          { alg }
        : alg === "box_seal"
          ? { alg, bytes: fromBase64(run.encrypted_share_code) }
          : { alg, cipher: run.encrypted_share_code };
    return {
      type: "completed",
      validUntil: run.valid_until ?? undefined,
      sealedShareCode,
    };
  }
  return {
    type: "failed",
    code: run.error_code ?? "FAILED",
    message: run.error_message ?? "Run failed",
    terminal: true,
    ...(run.status === "cancelled" || run.status === "interrupted"
      ? { cause: run.status }
      : {}),
  };
}

export function registerRunRoutes(app: WebFastifyInstance, deps: RunRoutesDeps): void {
  const { db, engine, entitlements, artifactStore, env, log } = deps;
  const requireUser = makeRequireUser(db);

  /**
   * Loads a run scoped to the caller, or replies 404 and returns null. Centralizes
   * the ownership gate so every per-run route rejects a foreign/missing id the same
   * way (404, no signal). Returns the run id (already verified to belong to the
   * user) on success.
   */
  async function authorizeRun(
    request: FastifyRequest,
    reply: FastifyReply,
    userId: string
  ): Promise<string | null> {
    const { id } = request.params as { id: string };
    const run = await getRunById(db, id, userId);
    if (!run) {
      await reply.code(404).send({ error: "not_found" });
      return null;
    }
    return run.id;
  }

  /**
   * Create a run. Verifies the member belongs to the caller, checks the
   * entitlement gate, requires a vault (its public key is the seal recipient for
   * all outputs — without it the worker could not protect E2EE results), inserts
   * the run row, and enqueues a client-custody run with the inline plaintext
   * applicant. Returns `{ runId }`.
   *
   * SECURITY: the applicant is passed straight to the engine (which keeps it in a
   * local const for the run only) and is NEVER logged or persisted here.
   */
  app.post("/api/runs", { preHandler: requireUser }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthorized" });

    const parsed = createRunBodySchema.safeParse(request.body);
    if (!parsed.success) {
      // NOTE: never include request.body in the response or any log — it carries
      // the plaintext applicant.
      return reply.code(400).send({ error: "invalid_run" });
    }
    const { memberId, applicant, purpose, twoFactorMethod } = parsed.data;

    // Entitlement gate (cloud seam; self-host = always true). Reject before doing
    // any work when the caller may not start a run.
    if (!(await entitlements.canCreateRun(user.id))) {
      return reply.code(403).send({ error: "run_not_allowed" });
    }

    // Ownership: the member must belong to the caller. A missing/foreign member is
    // 404 (indistinguishable). We only need its identity for the status label; the
    // applicant secret comes inline.
    const member = await getFamilyMemberById(db, memberId, user.id);
    if (!member) {
      return reply.code(404).send({ error: "member_not_found" });
    }

    // Client custody seals every output to the user's vault public key. No vault →
    // no recipient key → we cannot run an E2EE flow; ask the client to set one up.
    const vault = await getVault(db, user.id);
    if (!vault) {
      return reply.code(409).send({ error: "no_vault" });
    }

    // Insert the run row first so the engine's runId is a real, ownership-scoped
    // row. The `idx_runs_one_active_per_member` partial unique index throws when
    // an active run already exists for this member → surface as 409.
    let runId: string;
    try {
      const run = await insertRun(db, {
        user_id: user.id,
        family_member_id: member.id,
        trigger: "manual",
      });
      runId = run.id;
    } catch (err) {
      // A unique-violation here means a run for this member is already active.
      if (isUniqueViolation(err)) {
        return reply.code(409).send({ error: "run_already_active" });
      }
      throw err;
    }

    const enqueueResult = engine.enqueueRun({
      runId,
      ownerKey: ownerKeyFor(user.id),
      custody: "client",
      recipientPublicKey: new Uint8Array(vault.public_key),
      applicant: {
        kind: "inline",
        applicant: applicant as Applicant,
        purpose: purpose as Purpose,
        twoFactorMethod: twoFactorMethod as TwoFactorMethod | undefined,
        memberName: member.display_name,
      },
      trigger: "manual",
      headless: env.EVISA_HEADLESS,
      diagnosticsMode: env.EVISA_DIAGNOSTICS_MODE,
    });

    if (!enqueueResult.accepted) {
      // The engine deduped this run id (already enqueued). Treat as already active.
      return reply.code(409).send({ error: "run_already_active" });
    }

    // Log the run id and member only — NEVER the applicant.
    log.info({ runId, memberId: member.id, custody: "client" }, "Run enqueued (web)");
    return reply.code(201).send({ runId });
  });

  /**
   * Stream a run's events over SSE. Ownership-checked. Supports `Last-Event-ID`
   * (the bus replays the full backlog on subscribe; the SSE helper skips frames
   * the client already received). The connection stays open until the run reaches
   * a terminal event or the client disconnects.
   */
  app.get("/api/runs/:id/events", { preHandler: requireUser }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthorized" });

    const { id } = request.params as { id: string };
    const run = await getRunById(db, id, user.id);
    if (!run) {
      return reply.code(404).send({ error: "not_found" });
    }

    // If the run already finished and the in-memory bus has no live topic for it
    // (a reconnect after the terminal-grace window, or a fresh process after a
    // restart), `subscribe()` would hand back a brand-new, never-ending topic and
    // the SSE connection would hang forever. Detect that case — terminal in the DB
    // AND no live snapshot — and deliver the reconstructed terminal frame once,
    // then close, so a late client learns the final state instantly. A run still
    // within the grace window keeps a snapshot, so the normal subscribe path below
    // (which replays the full backlog) is used and `Last-Event-ID` resume works.
    if (!engine.getSnapshot(run.id)) {
      const terminal = terminalEventForRun(run);
      if (terminal) {
        streamTerminalRunEvent(request, reply, terminal);
        return reply;
      }
    }

    const events = engine.subscribe(run.id);
    await streamRunEvents(request, reply, events, { log });
    return reply;
  });

  /**
   * Submit the 2FA code for an in-flight run. Ownership-checked. Resolves the
   * exact pending gate in the worker process via the engine. Returns 202 when the
   * code was delivered to a waiting run, 409 when no run is currently awaiting a
   * code (already submitted, timed out, or not at the 2FA step). The code is never
   * logged.
   */
  app.post("/api/runs/:id/code", { preHandler: requireUser }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthorized" });

    const runId = await authorizeRun(request, reply, user.id);
    if (!runId) return reply; // 404 already sent

    const parsed = submitCodeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_code" });
    }
    const delivered = engine.submitCode(runId, parsed.data.code);
    if (!delivered) {
      return reply.code(409).send({ error: "no_pending_challenge" });
    }
    return reply.code(202).send({ ok: true });
  });

  /**
   * Cancel an in-flight (queued/running) run. Ownership-checked. Returns 202 when
   * the run was cancelled, 409 when it was not cancellable (already terminal or no
   * longer active). The engine publishes the terminal event and persists the
   * cancelled status.
   */
  app.post(
    "/api/runs/:id/cancel",
    { preHandler: requireUser },
    async (request, reply) => {
      const user = request.user;
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const runId = await authorizeRun(request, reply, user.id);
      if (!runId) return reply; // 404 already sent

      const cancelled = engine.cancel(runId);
      if (!cancelled) {
        return reply.code(409).send({ error: "not_cancellable" });
      }
      return reply.code(202).send({ ok: true });
    }
  );

  /**
   * List a run's stored sealed artifacts (metadata only — no bytes). Ownership-
   * checked. The client uses the ids to fetch and decrypt each artifact below.
   */
  app.get(
    "/api/runs/:id/artifacts",
    { preHandler: requireUser },
    async (request, reply) => {
      const user = request.user;
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const runId = await authorizeRun(request, reply, user.id);
      if (!runId) return reply; // 404 already sent

      const artifacts = await artifactStore.listForRun(runId);
      return reply.code(200).send({ artifacts: artifacts.map(toArtifactListItem) });
    }
  );

  /**
   * Stream one sealed artifact's bytes. Ownership-checked twice over: the run must
   * belong to the caller, and the artifact must belong to that run (the store
   * scopes its lookup to `runId`). The bytes are an OPAQUE sealed blob, served as
   * `application/octet-stream` for the client to open in-browser with its private
   * key — the server never unseals them. A neutral, kind-derived download name is
   * used so the at-rest filename leaks no identity.
   */
  app.get(
    "/api/runs/:id/artifacts/:artifactId",
    { preHandler: requireUser },
    async (request, reply) => {
      const user = request.user;
      if (!user) return reply.code(401).send({ error: "unauthorized" });

      const runId = await authorizeRun(request, reply, user.id);
      if (!runId) return reply; // 404 already sent

      const { artifactId } = request.params as { artifactId: string };
      const artifact = await artifactStore.getSealed(runId, artifactId);
      // A missing artifact, or one offloaded with no inline bytes (storage='disk'
      // — a cloud seam not used in self-host), is a 404 either way.
      if (!artifact?.bytes) {
        return reply.code(404).send({ error: "artifact_not_found" });
      }

      // Opaque sealed bytes. `application/octet-stream` + an attachment name that
      // is the stored (neutral) filename plus a `.sealed` marker so a manual
      // download is obviously not directly openable. The real filename is sealed
      // inside the envelope.
      const downloadName = `${artifact.filename ?? artifact.kind ?? "artifact"}.sealed`;
      reply
        .header("content-type", "application/octet-stream")
        .header("content-length", String(artifact.bytes.byteLength))
        .header("content-disposition", `attachment; filename="${downloadName}"`)
        // These are user-specific sealed blobs; never let a shared cache hold them.
        .header("cache-control", "no-store");
      return reply.send(artifact.bytes);
    }
  );

  /**
   * The caller's run history (newest first). Status fields only — no secrets, no
   * applicant data, no (sealed) share code. Scoped to the session user.
   */
  app.get("/api/runs", { preHandler: requireUser }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthorized" });

    const runs = await listRunsForUser(db, user.id);
    return reply.code(200).send({ runs });
  });
}
