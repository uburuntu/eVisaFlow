import { isNotNull, lt, or } from "drizzle-orm";
import type { Db } from "./client.js";
import { magicLinkTokens, sessions } from "./schema.js";

/**
 * Periodic-cleanup accessors for the web-auth tables (added in migration 004).
 *
 * These delete rows that are no longer useful so the tables do not grow without
 * bound. They hold no secrets in plaintext (sessions and magic-link tokens store
 * only a hash), so deletion is purely housekeeping. Driven by the cleanup cron.
 */

/**
 * Deletes every session whose `expires_at` is strictly before `now`. Returns the
 * number of rows removed (drives the cleanup cron's logging). `now` is an ISO-8601
 * string to match the stored TIMESTAMPTZ representation.
 */
export async function deleteExpiredSessions(db: Db, now: string): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, now))
    .returning({ id: sessions.id });
  return deleted.length;
}

/**
 * Deletes magic-link tokens that are no longer usable: either already consumed
 * (single-use is spent) or expired (`expires_at` strictly before `now`). Returns
 * the number of rows removed. `now` is an ISO-8601 string.
 */
export async function deleteConsumedOrExpiredMagicLinkTokens(
  db: Db,
  now: string
): Promise<number> {
  const deleted = await db
    .delete(magicLinkTokens)
    .where(or(isNotNull(magicLinkTokens.consumedAt), lt(magicLinkTokens.expiresAt, now)))
    .returning({ id: magicLinkTokens.id });
  return deleted.length;
}
