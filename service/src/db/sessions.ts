import { and, eq, gt, lt } from "drizzle-orm";
import type { Db } from "./client.js";
import { sessions } from "./schema.js";

/**
 * Drizzle accessors for the `sessions` table (migration 004).
 *
 * SECURITY: the table stores ONLY the SHA-256 hash of the bearer token, never the
 * token itself — the raw token lives solely in the user's HttpOnly cookie. A
 * stolen database therefore yields no usable session tokens. These accessors
 * only ever accept/return the hash; hashing happens in `auth/session.ts`.
 */

export interface DbSession {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
}

type SessionRow = typeof sessions.$inferSelect;

function toDbSession(row: SessionRow): DbSession {
  return {
    id: row.id,
    user_id: row.userId,
    token_hash: row.tokenHash,
    created_at: row.createdAt,
    expires_at: row.expiresAt,
  };
}

/**
 * Inserts a session row. `token_hash` MUST already be the hash of the raw token
 * (the caller never stores the raw token). `expires_at` is an ISO-8601 string to
 * match the stored TIMESTAMPTZ representation.
 */
export async function createSession(
  db: Db,
  session: { user_id: string; token_hash: string; expires_at: string }
): Promise<DbSession> {
  const [row] = await db
    .insert(sessions)
    .values({
      userId: session.user_id,
      tokenHash: session.token_hash,
      expiresAt: session.expires_at,
    })
    .returning();
  return toDbSession(row);
}

/**
 * Looks up a session by its token hash, returning it ONLY if it has not yet
 * expired (`expires_at` strictly after now). Returns null for an unknown or
 * expired hash so callers treat "expired" and "absent" identically (no signal
 * about whether the token ever existed).
 */
export async function findValidSessionByTokenHash(
  db: Db,
  tokenHash: string
): Promise<DbSession | null> {
  const now = new Date().toISOString();
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
    .limit(1);
  return row ? toDbSession(row) : null;
}

/**
 * Deletes the session with the given token hash (logout). Returns true when a
 * row was removed. Idempotent: deleting an unknown hash is a no-op returning
 * false.
 */
export async function deleteSession(db: Db, tokenHash: string): Promise<boolean> {
  const deleted = await db
    .delete(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .returning({ id: sessions.id });
  return deleted.length > 0;
}

/**
 * Deletes every session whose `expires_at` is strictly before `now`. Returns the
 * number of rows removed (drives the cleanup cron's logging). `now` is an
 * ISO-8601 string. NOTE: `db/cleanup.ts#deleteExpiredSessions` is the cron's
 * entry point today; this mirror lives alongside the other session accessors so
 * the auth layer has a single import surface.
 */
export async function deleteExpiredSessions(db: Db, now: string): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, now))
    .returning({ id: sessions.id });
  return deleted.length;
}
