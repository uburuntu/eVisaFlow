import type { SupabaseClient } from "@supabase/supabase-js";

export interface DbUser {
  id: string;
  telegram_id: number;
  telegram_handle: string | null;
  first_name: string;
  next_scheduled_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function upsertUser(
  db: SupabaseClient,
  telegramId: number,
  firstName: string,
  handle: string | null,
  scheduleIntervalDays: number,
): Promise<DbUser> {
  const { data, error } = await db
    .from("users")
    .upsert(
      {
        telegram_id: telegramId,
        first_name: firstName,
        telegram_handle: handle,
        next_scheduled_at: new Date(
          Date.now() + scheduleIntervalDays * 86_400_000,
        ).toISOString(),
      },
      { onConflict: "telegram_id" },
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getUserByTelegramId(
  db: SupabaseClient,
  telegramId: number,
): Promise<DbUser | null> {
  const { data, error } = await db
    .from("users")
    .select()
    .eq("telegram_id", telegramId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getUsersDueForSchedule(
  db: SupabaseClient,
): Promise<DbUser[]> {
  const { data, error } = await db
    .from("users")
    .select()
    .lte("next_scheduled_at", new Date().toISOString())
    .not("next_scheduled_at", "is", null);
  if (error) throw error;
  return data ?? [];
}

export async function advanceSchedule(
  db: SupabaseClient,
  userId: string,
  intervalDays: number,
): Promise<void> {
  const nextDate = new Date(
    Date.now() + intervalDays * 86_400_000,
  ).toISOString();
  const { error } = await db
    .from("users")
    .update({ next_scheduled_at: nextDate })
    .eq("id", userId);
  if (error) throw error;
}
