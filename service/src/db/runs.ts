import type { Db } from "./client.js";

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

export async function insertRun(
  db: Db,
  run: {
    user_id: string;
    family_member_id: string;
    trigger: "manual" | "scheduled";
  }
): Promise<DbRun> {
  const { data, error } = await db
    .from("runs")
    .insert({
      ...run,
      status: "pending",
      started_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
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
  const payload: Record<string, unknown> = { status: update.status };
  if (update.encrypted_share_code !== undefined) {
    payload.encrypted_share_code = update.encrypted_share_code;
  }
  if (update.valid_until !== undefined) payload.valid_until = update.valid_until;
  if (update.error_code !== undefined) payload.error_code = update.error_code;
  if (update.error_message !== undefined) payload.error_message = update.error_message;
  if (TERMINAL_RUN_STATUSES.includes(update.status as TerminalRunStatus)) {
    payload.completed_at = new Date().toISOString();
  }

  let query = db.from("runs").update(payload).eq("id", runId);
  if (options.requireActive ?? true) {
    query = query.in("status", NON_TERMINAL_RUN_STATUSES);
  }

  const { data, error } = await query.select("id").maybeSingle();
  if (error) throw error;
  const updated = data !== null;
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
  const { error } = await db.from("run_events").insert(event);
  if (error) throw error;
}

export async function markNonTerminalRunsInterrupted(
  db: Db,
  reason: string,
  options: {
    runIds?: string[];
    staleBefore?: Date;
  } = {}
): Promise<void> {
  let query = db
    .from("runs")
    .update({
      status: "interrupted",
      error_code: "SERVICE_RESTARTED",
      error_message: reason.slice(0, 500),
      completed_at: new Date().toISOString(),
    })
    .in("status", ["pending", "running", "awaiting_2fa"]);

  if (options.runIds !== undefined) {
    if (options.runIds.length === 0) {
      return;
    }
    query = query.in("id", options.runIds);
  }

  if (options.staleBefore !== undefined) {
    query = query.lt("started_at", options.staleBefore.toISOString());
  }

  const { error } = await query;
  if (error) throw error;
}
