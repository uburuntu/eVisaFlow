import {
  MobileChallengeSubmissionSchema,
  MobileProfileSlotRequestSchema,
  MobileRunCreateRequestSchema,
} from "evisa-flow/protocol";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Logger } from "../utils/logger.js";
import type { MobileAuth } from "./mobile-auth.js";
import { MobileRateLimiter } from "./mobile-rate-limiter.js";
import type { MobileRunCoordinator } from "./mobile-run-coordinator.js";
import type { MobileStore } from "./mobile-store.js";

const IdParamsSchema = z.object({ id: z.uuid() });
const ArtifactParamsSchema = z.object({ id: z.uuid(), artifactId: z.uuid() });

interface MobileApiDependencies {
  auth: MobileAuth;
  coordinator: Pick<MobileRunCoordinator, "start" | "submitChallenge" | "cancel">;
  store: Pick<
    MobileStore,
    | "getMe"
    | "getActiveRunIds"
    | "deleteAccount"
    | "upsertProfileSlot"
    | "deleteProfileSlot"
    | "createRun"
    | "getRun"
    | "getEvents"
    | "updateRun"
    | "claimResult"
    | "downloadArtifact"
  >;
  log: Logger;
}

type AuthenticatedRequest = FastifyRequest & { mobileUserId: string };

export function buildMobileApi(dependencies: MobileApiDependencies) {
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    requestTimeout: 30_000,
  });
  const rateLimiter = new MobileRateLimiter();

  app.get("/live", async () => ({ live: true }));
  app.get("/ready", async () => ({ ready: true }));

  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/v1/")) {
      applyPrivateResponseHeaders(reply);
    }
    return payload;
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/v1/")) return;
    const authorization = request.headers.authorization;
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) {
      return sendError(reply, 401, "AUTH_REQUIRED", "Authentication is required.", false);
    }
    const userId = await dependencies.auth.getUserId(token);
    if (!userId) {
      return sendError(
        reply,
        401,
        "AUTH_INVALID",
        "The session is no longer valid.",
        false
      );
    }
    (request as AuthenticatedRequest).mobileUserId = userId;
  });

  app.get("/v1/me", async (request) => dependencies.store.getMe(userId(request)));

  app.delete("/v1/me", async (request, reply) => {
    const ownerId = userId(request);
    const activeRunIds = await dependencies.store.getActiveRunIds(ownerId);
    for (const runId of activeRunIds) {
      dependencies.coordinator.cancel(ownerId, runId);
    }
    await dependencies.store.deleteAccount(ownerId);
    return reply.code(204).send();
  });

  app.put("/v1/profile-slots/:id", async (request, reply) => {
    const params = parse(IdParamsSchema, request.params, reply);
    const body = parse(MobileProfileSlotRequestSchema, request.body, reply);
    if (!params || !body) return;
    if (rateLimited(rateLimiter, reply, `profiles:${userId(request)}`, 20, 15 * 60_000)) {
      return;
    }
    if (params.id !== body.profileId) {
      return sendError(
        reply,
        400,
        "PROFILE_ID_MISMATCH",
        "Profile identifiers do not match.",
        false
      );
    }
    await dependencies.store.upsertProfileSlot(userId(request), params.id);
    return reply.code(204).send();
  });

  app.delete("/v1/profile-slots/:id", async (request, reply) => {
    const params = parse(IdParamsSchema, request.params, reply);
    if (!params) return;
    await dependencies.store.deleteProfileSlot(userId(request), params.id);
    return reply.code(204).send();
  });

  app.post("/v1/runs", async (request, reply) => {
    const body = parse(MobileRunCreateRequestSchema, request.body, reply);
    if (!body) return;
    const ownerId = userId(request);
    if (rateLimited(rateLimiter, reply, `runs:${ownerId}`, 10, 15 * 60_000)) return;
    const existing = await dependencies.store.getRun(ownerId, body.clientRunId);
    if (existing) return reply.code(200).send(existing);
    const run = await dependencies.store.createRun(ownerId, body);
    try {
      dependencies.coordinator.start(ownerId, body);
    } catch (error) {
      await dependencies.store.updateRun(body.clientRunId, {
        status: "interrupted",
        phase: "failed",
        errorCode: "QUEUE_START_FAILED",
        retryable: true,
        clearRequest: true,
      });
      throw error;
    }
    return reply.code(202).send(run);
  });

  app.get("/v1/runs/:id", async (request, reply) => {
    const params = parse(IdParamsSchema, request.params, reply);
    if (!params) return;
    const run = await dependencies.store.getRun(userId(request), params.id);
    if (!run) return sendError(reply, 404, "RUN_NOT_FOUND", "Run not found.", false);
    return run;
  });

  app.get("/v1/runs/:id/events", async (request, reply) => {
    const params = parse(IdParamsSchema, request.params, reply);
    if (!params) return;
    const ownerId = userId(request);
    const run = await dependencies.store.getRun(ownerId, params.id);
    if (!run) return sendError(reply, 404, "RUN_NOT_FOUND", "Run not found.", false);

    const lastEventId = Number(request.headers["last-event-id"] ?? 0);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Pragma: "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    });
    let cursor = Number.isSafeInteger(lastEventId) && lastEventId >= 0 ? lastEventId : 0;
    let closed = false;
    request.raw.on("close", () => {
      closed = true;
    });

    while (!closed) {
      const events = await dependencies.store.getEvents(ownerId, params.id, cursor);
      for (const event of events) {
        cursor = event.id;
        reply.raw.write(
          `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
        );
      }
      const snapshot = await dependencies.store.getRun(ownerId, params.id);
      if (!snapshot || isTerminal(snapshot.status)) break;
      reply.raw.write(": heartbeat\n\n");
      await delay(10_000);
    }
    reply.raw.end();
  });

  app.post("/v1/runs/:id/challenge", async (request, reply) => {
    const params = parse(IdParamsSchema, request.params, reply);
    const body = parse(MobileChallengeSubmissionSchema, request.body, reply);
    if (!params || !body) return;
    const ownerId = userId(request);
    if (
      rateLimited(rateLimiter, reply, `challenge:${ownerId}:${params.id}`, 6, 10 * 60_000)
    ) {
      return;
    }
    const run = await dependencies.store.getRun(ownerId, params.id);
    if (!run) return sendError(reply, 404, "RUN_NOT_FOUND", "Run not found.", false);
    if (run.status !== "awaiting_2fa") {
      return sendError(
        reply,
        409,
        "CHALLENGE_NOT_ACTIVE",
        "No security code is expected.",
        false
      );
    }
    if (!dependencies.coordinator.submitChallenge(ownerId, params.id, body.code)) {
      return sendError(
        reply,
        409,
        "CHALLENGE_EXPIRED",
        "The security code request expired.",
        true
      );
    }
    return (await dependencies.store.getRun(ownerId, params.id)) ?? run;
  });

  app.post("/v1/runs/:id/cancel", async (request, reply) => {
    const params = parse(IdParamsSchema, request.params, reply);
    if (!params) return;
    const ownerId = userId(request);
    const run = await dependencies.store.getRun(ownerId, params.id);
    if (!run) return sendError(reply, 404, "RUN_NOT_FOUND", "Run not found.", false);
    if (!isTerminal(run.status)) {
      dependencies.coordinator.cancel(ownerId, params.id);
      await dependencies.store.updateRun(params.id, {
        status: "cancelled",
        phase: "failed",
        errorCode: "FLOW_CANCELLED",
        clearRequest: true,
      });
    }
    return (await dependencies.store.getRun(ownerId, params.id)) ?? run;
  });

  app.post("/v1/runs/:id/claim-result", async (request, reply) => {
    const params = parse(IdParamsSchema, request.params, reply);
    if (!params) return;
    const ownerId = userId(request);
    if (rateLimited(rateLimiter, reply, `claim:${ownerId}`, 10, 15 * 60_000)) return;
    const result = await dependencies.store.claimResult(ownerId, params.id);
    if (!result) {
      return sendError(
        reply,
        409,
        "RESULT_NOT_READY",
        "The result is not ready to claim.",
        true
      );
    }
    return result;
  });

  app.get("/v1/runs/:id/artifacts/:artifactId", async (request, reply) => {
    const params = parse(ArtifactParamsSchema, request.params, reply);
    if (!params) return;
    const ownerId = userId(request);
    if (rateLimited(rateLimiter, reply, `artifacts:${ownerId}`, 30, 5 * 60_000)) {
      return;
    }
    const artifact = await dependencies.store.downloadArtifact(
      ownerId,
      params.id,
      params.artifactId
    );
    if (!artifact) {
      return sendError(reply, 404, "ARTIFACT_NOT_FOUND", "Artifact not found.", false);
    }
    return reply
      .header("Content-Type", artifact.descriptor.contentType)
      .header("Content-Length", String(artifact.bytes.byteLength))
      .header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(artifact.descriptor.filename)}`
      )
      .send(artifact.bytes);
  });

  app.setErrorHandler((error, request, reply) => {
    dependencies.log.error(
      { err: error, method: request.method, path: request.url.split("?", 1)[0] },
      "Mobile API request failed"
    );
    const mapped = mapError(error);
    sendError(reply, mapped.status, mapped.code, mapped.message, mapped.retryable);
  });

  return app;
}

function userId(request: FastifyRequest): string {
  return (request as AuthenticatedRequest).mobileUserId;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, reply: FastifyReply): T | null {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  sendError(reply, 400, "REQUEST_INVALID", "The request is invalid.", false);
  return null;
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  retryable: boolean
) {
  return reply.code(status).send({ code, message, retryable });
}

function applyPrivateResponseHeaders(reply: FastifyReply): void {
  reply
    .header("Cache-Control", "no-store")
    .header("Pragma", "no-cache")
    .header("X-Content-Type-Options", "nosniff")
    .header("X-Frame-Options", "DENY")
    .header("Referrer-Policy", "no-referrer");
}

function rateLimited(
  limiter: MobileRateLimiter,
  reply: FastifyReply,
  key: string,
  limit: number,
  windowMs: number
): boolean {
  const retryAfter = limiter.consume(key, limit, windowMs);
  if (retryAfter === null) return false;
  reply.header("Retry-After", String(retryAfter));
  sendError(
    reply,
    429,
    "RATE_LIMITED",
    "Too many requests. Wait before trying again.",
    true
  );
  return true;
}

function isTerminal(status: string): boolean {
  return [
    "succeeded",
    "partial_success",
    "failed",
    "cancelled",
    "interrupted",
    "expired",
  ].includes(status);
}

function mapError(error: unknown): {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
} {
  const message = error instanceof Error ? error.message : "";
  if (message === "SERVICE_MAINTENANCE") {
    return {
      status: 503,
      code: message,
      message: "The service is temporarily paused.",
      retryable: true,
    };
  }
  if (message === "FREE_RUN_LIMIT") {
    return {
      status: 402,
      code: message,
      message: "The free result limit has been reached.",
      retryable: false,
    };
  }
  if (message === "PROFILE_NOT_FOUND") {
    return {
      status: 404,
      code: message,
      message: "Profile slot not found.",
      retryable: false,
    };
  }
  if (error && typeof error === "object" && "code" in error && error.code === "23505") {
    return {
      status: 409,
      code: "RUN_ALREADY_ACTIVE",
      message: "Another run is already active.",
      retryable: true,
    };
  }
  if (error && typeof error === "object" && "code" in error && error.code === "P0001") {
    return {
      status: 402,
      code: "PROFILE_LIMIT",
      message: "The profile limit has been reached.",
      retryable: false,
    };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "The service could not complete the request.",
    retryable: true,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
