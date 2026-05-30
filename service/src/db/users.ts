import { and, eq, isNotNull, lte } from "drizzle-orm";
import type { Db } from "./client.js";
import { users } from "./schema.js";

export interface DbUser {
  id: string;
  telegram_id: number;
  telegram_handle: string | null;
  first_name: string;
  next_scheduled_at: string | null;
  created_at: string;
  updated_at: string;
}

type UserRow = typeof users.$inferSelect;

function toDbUser(row: UserRow): DbUser {
  return {
    id: row.id,
    telegram_id: row.telegramId,
    telegram_handle: row.telegramHandle,
    first_name: row.firstName,
    next_scheduled_at: row.nextScheduledAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export async function upsertUser(
  db: Db,
  telegramId: number,
  firstName: string,
  handle: string | null,
  scheduleIntervalDays: number
): Promise<DbUser> {
  const nextScheduledAt = new Date(
    Date.now() + scheduleIntervalDays * 86_400_000
  ).toISOString();
  const [row] = await db
    .insert(users)
    .values({
      telegramId,
      firstName,
      telegramHandle: handle,
      nextScheduledAt,
    })
    .onConflictDoUpdate({
      target: users.telegramId,
      set: {
        firstName,
        telegramHandle: handle,
        nextScheduledAt,
      },
    })
    .returning();
  return toDbUser(row);
}

export async function getUserByTelegramId(
  db: Db,
  telegramId: number
): Promise<DbUser | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.telegramId, telegramId))
    .limit(1);
  return row ? toDbUser(row) : null;
}

export async function getUsersDueForSchedule(db: Db): Promise<DbUser[]> {
  const now = new Date().toISOString();
  const rows = await db
    .select()
    .from(users)
    .where(and(lte(users.nextScheduledAt, now), isNotNull(users.nextScheduledAt)));
  return rows.map(toDbUser);
}

export async function advanceSchedule(
  db: Db,
  userId: string,
  intervalDays: number
): Promise<void> {
  const nextDate = new Date(Date.now() + intervalDays * 86_400_000).toISOString();
  await db.update(users).set({ nextScheduledAt: nextDate }).where(eq(users.id, userId));
}
