import { and, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "./client.js";
import { runEvents, runs } from "./schema.js";

export const NON_TERMINAL_RUN_STATUSES = ["pending", "running", "awaiting_2fa"] as const;
export const TERMINAL_RUN_STATUSES = [
  "success",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type NonTerminalRunStatus = (typeof NON_TERMINAL_RUN_STATUSES)[number];
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];
export type RunStatus = NonTerminalRunStatus | TerminalRunStatus;

export class RunStatusConflictError extends Error {
  constructor(runId: string, status: string) {
    super(`Run ${runId} could not be moved to ${status} because it is no longer active`);
    this.name = "RunStatusConflictError";
  }
}

export interface DbRun {
  id: string;
  user_id: string;
  family_member_id: string;
  trigger: string;
  status: string;
  encrypted_share_code: string | null;
  valid_until: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

type RunRow = typeof runs.$inferSelect;

function toDbRun(row: RunRow): DbRun {
  return {
    id: row.id,
    user_id: row.userId,
    family_member_id: row.familyMemberId,
    trigger: row.trigger,
    status: row.status,
    encrypted_share_code: row.encryptedShareCode,
    valid_until: row.validUntil,
    error_code: row.errorCode,
    error_message: row.errorMessage,
    started_at: row.startedAt,
    completed_at: row.completedAt,
    created_at: row.createdAt,
  };
}

export async function insertRun(
  db: Db,
  run: {
    user_id: string;
    family_member_id: string;
    trigger: "manual" | "scheduled";
  }
): Promise<DbRun> {
  // No conflict handling: the `idx_runs_one_active_per_member` partial unique
  // index throws when an active run already exists, which the caller relies on
  // to surface an "already queued" message.
  const [row] = await db
    .insert(runs)
    .values({
      userId: run.user_id,
      familyMemberId: run.family_member_id,
      trigger: run.trigger,
      status: "pending",
      startedAt: new Date().toISOString(),
    })
    .returning();
  return toDbRun(row);
}

export async function updateRunStatus(
  db: Db,
  runId: string,
  update: {
    status: RunStatus;
    encrypted_share_code?: string;
    valid_until?: string;
    error_code?: string;
    error_message?: string;
  },
  options: {
    requireActive?: boolean;
    throwOnConflict?: boolean;
  } = {}
): Promise<boolean> {
  const payload: Partial<typeof runs.$inferInsert> = { status: update.status };
  if (update.encrypted_share_code !== undefined) {
    payload.encryptedShareCode = update.encrypted_share_code;
  }
  if (update.valid_until !== undefined) payload.validUntil = update.valid_until;
  if (update.error_code !== undefined) payload.errorCode = update.error_code;
  if (update.error_message !== undefined) payload.errorMessage = update.error_message;
  if (TERMINAL_RUN_STATUSES.includes(update.status as TerminalRunStatus)) {
    payload.completedAt = new Date().toISOString();
  }

  const condition =
    (options.requireActive ?? true)
      ? and(eq(runs.id, runId), inArray(runs.status, [...NON_TERMINAL_RUN_STATUSES]))
      : eq(runs.id, runId);

  const updatedRows = await db
    .update(runs)
    .set(payload)
    .where(condition)
    .returning({ id: runs.id });

  const updated = updatedRows.length > 0;
  if (!updated && options.throwOnConflict) {
    throw new RunStatusConflictError(runId, update.status);
  }
  return updated;
}

export async function insertRunEvent(
  db: Db,
  event: {
    run_id: string;
    event_type: string;
    phase?: string;
    page_kind?: string;
    operation?: string;
    duration_ms?: number;
    step_id?: string;
    error_code?: string;
    message?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await db.insert(runEvents).values({
    runId: event.run_id,
    eventType: event.event_type,
    phase: event.phase,
    pageKind: event.page_kind,
    operation: event.operation,
    durationMs: event.duration_ms,
    stepId: event.step_id,
    errorCode: event.error_code,
    message: event.message,
    metadata: event.metadata,
  });
}

export async function markNonTerminalRunsInterrupted(
  db: Db,
  reason: string,
  options: {
    runIds?: string[];
    staleBefore?: Date;
  } = {}
): Promise<void> {
  if (options.runIds !== undefined && options.runIds.length === 0) {
    return;
  }

  const conditions = [inArray(runs.status, [...NON_TERMINAL_RUN_STATUSES])];
  if (options.runIds !== undefined) {
    conditions.push(inArray(runs.id, options.runIds));
  }
  if (options.staleBefore !== undefined) {
    conditions.push(lt(runs.startedAt, options.staleBefore.toISOString()));
  }

  await db
    .update(runs)
    .set({
      status: "interrupted",
      errorCode: "SERVICE_RESTARTED",
      errorMessage: reason.slice(0, 500),
      completedAt: new Date().toISOString(),
    })
    .where(and(...conditions));
}
