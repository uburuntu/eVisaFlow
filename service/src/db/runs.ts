import type { SupabaseClient } from "@supabase/supabase-js";

export interface DbRun {
  id: string;
  user_id: string;
  family_member_id: string;
  trigger: string;
  status: string;
  share_code: string | null;
  valid_until: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export async function insertRun(
  db: SupabaseClient,
  run: {
    user_id: string;
    family_member_id: string;
    trigger: "manual" | "scheduled";
  },
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
  db: SupabaseClient,
  runId: string,
  update: {
    status: string;
    share_code?: string;
    valid_until?: string;
    error_message?: string;
  },
): Promise<void> {
  const payload: Record<string, unknown> = { status: update.status };
  if (update.share_code !== undefined) payload.share_code = update.share_code;
  if (update.valid_until !== undefined) payload.valid_until = update.valid_until;
  if (update.error_message !== undefined) payload.error_message = update.error_message;
  if (update.status === "success" || update.status === "failed") {
    payload.completed_at = new Date().toISOString();
  }
  const { error } = await db.from("runs").update(payload).eq("id", runId);
  if (error) throw error;
}
