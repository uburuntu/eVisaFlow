import { and, eq, isNotNull, lte } from "drizzle-orm";
import type { Db } from "./client.js";
import { users } from "./schema.js";

export interface DbUser {
  id: string;
  // Nullable since migration 004: web users carry an email instead of a Telegram id.
  telegram_id: number | null;
  telegram_handle: string | null;
  first_name: string | null;
  email: string | null;
  email_verified: boolean;
  display_name: string | null;
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
    email: row.email,
    email_verified: row.emailVerified,
    display_name: row.displayName,
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

/**
 * Fetches a user by their UUID primary key, or null when absent. Used by the web
 * session layer to resolve `request.user` from a validated session's `user_id`.
 */
export async function getUserById(db: Db, id: string): Promise<DbUser | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ? toDbUser(row) : null;
}

/** Fetches a user by their (case-insensitive-normalized) email, or null. */
export async function getUserByEmail(db: Db, email: string): Promise<DbUser | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1);
  return row ? toDbUser(row) : null;
}

/**
 * Normalizes an email for storage/lookup: trims surrounding whitespace and
 * lower-cases it so the same address always resolves to one row (the `email`
 * UNIQUE constraint is case-sensitive at the DB level). Exported so the auth
 * routes normalize identically before issuing or consuming a magic link.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Web sign-in by email (magic-link). Finds the existing user for `email` or
 * creates one, marking `email_verified` true (the magic link proves control of
 * the inbox). Web users have no Telegram id and are NOT placed on the bot's
 * reminder schedule, so `next_scheduled_at` is left NULL. Idempotent: a second
 * verification for the same address returns the same row.
 *
 * Uses INSERT … ON CONFLICT (email) so concurrent verifications for a new
 * address cannot create duplicate rows.
 */
export async function findOrCreateUserByEmail(db: Db, email: string): Promise<DbUser> {
  const normalized = normalizeEmail(email);
  const [row] = await db
    .insert(users)
    .values({ email: normalized, emailVerified: true })
    .onConflictDoUpdate({
      target: users.email,
      // The address is already verified by the link; ensure the flag is set even
      // for a pre-existing unverified row, without disturbing other columns.
      set: { emailVerified: true },
    })
    .returning();
  return toDbUser(row);
}

/**
 * Telegram Login sign-in WITHOUT an existing session: finds the user already
 * linked to `telegramId` or creates a fresh web user linked to it. The optional
 * `firstName`/`handle` from the verified Telegram payload are stored for display
 * but never overwrite an established row's name on subsequent logins. Web users
 * created this way are not on the bot reminder schedule (`next_scheduled_at`
 * NULL). Idempotent via INSERT … ON CONFLICT (telegram_id).
 */
export async function findOrCreateUserByTelegram(
  db: Db,
  telegramId: number,
  firstName: string | null,
  handle: string | null
): Promise<DbUser> {
  const [row] = await db
    .insert(users)
    .values({ telegramId, firstName, telegramHandle: handle })
    .onConflictDoUpdate({
      target: users.telegramId,
      // Refresh the handle (it can change on Telegram) but leave first_name and
      // the rest untouched so we never clobber a name the user set elsewhere.
      set: { telegramHandle: handle },
    })
    .returning();
  return toDbUser(row);
}

/**
 * Links `telegramId` onto an EXISTING user (Telegram Login while already signed
 * in via email). Returns the updated user, or null when the id is already linked
 * to a DIFFERENT user — the caller must surface a conflict rather than silently
 * stealing the link. Linking the same id already on this user is a no-op success.
 */
export async function linkTelegramId(
  db: Db,
  userId: string,
  telegramId: number
): Promise<DbUser | null> {
  const existing = await getUserByTelegramId(db, telegramId);
  if (existing && existing.id !== userId) {
    return null;
  }
  const [row] = await db
    .update(users)
    .set({ telegramId })
    .where(eq(users.id, userId))
    .returning();
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
