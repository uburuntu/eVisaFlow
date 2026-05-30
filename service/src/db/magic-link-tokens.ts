import { and, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { Db } from "./client.js";
import { magicLinkTokens } from "./schema.js";

/**
 * Drizzle accessors for the `magic_link_tokens` table (migration 004).
 *
 * SECURITY: like sessions, the table stores ONLY the SHA-256 hash of the token,
 * never the raw token (the raw token lives only in the emailed link). Tokens are
 * single-use (`consumed_at`) and short-TTL (`expires_at`). {@link consumeToken}
 * is the only read path and it both validates AND marks consumption in a single
 * atomic statement, so a token can never be redeemed twice even under a race.
 */

export interface DbMagicLinkToken {
  id: string;
  email: string;
  token_hash: string;
  consumed_at: string | null;
  created_at: string;
  expires_at: string;
}

type MagicLinkTokenRow = typeof magicLinkTokens.$inferSelect;

function toDbMagicLinkToken(row: MagicLinkTokenRow): DbMagicLinkToken {
  return {
    id: row.id,
    email: row.email,
    token_hash: row.tokenHash,
    consumed_at: row.consumedAt,
    created_at: row.createdAt,
    expires_at: row.expiresAt,
  };
}

/**
 * Inserts a magic-link token. `token_hash` MUST already be the hash of the raw
 * token (the raw token is only ever emailed, never stored). `expires_at` is an
 * ISO-8601 string bounding the short TTL.
 */
export async function createToken(
  db: Db,
  token: { email: string; token_hash: string; expires_at: string }
): Promise<DbMagicLinkToken> {
  const [row] = await db
    .insert(magicLinkTokens)
    .values({
      email: token.email,
      tokenHash: token.token_hash,
      expiresAt: token.expires_at,
    })
    .returning();
  return toDbMagicLinkToken(row);
}

/**
 * Atomically validates and consumes a magic-link token by its hash.
 *
 * Returns the matched token (with its `email`) ONLY when it is currently valid:
 * unconsumed AND unexpired. The UPDATE…RETURNING sets `consumed_at` in the same
 * statement and is guarded by `consumed_at IS NULL`, so a concurrent second call
 * matches zero rows — single-use is enforced atomically, never via a
 * read-then-write window. Returns null for an unknown, already-consumed, or
 * expired hash (callers must not distinguish these cases).
 */
export async function consumeToken(
  db: Db,
  tokenHash: string
): Promise<DbMagicLinkToken | null> {
  const now = new Date().toISOString();
  const [row] = await db
    .update(magicLinkTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(magicLinkTokens.tokenHash, tokenHash),
        isNull(magicLinkTokens.consumedAt),
        gt(magicLinkTokens.expiresAt, now)
      )
    )
    .returning();
  return row ? toDbMagicLinkToken(row) : null;
}

/**
 * Deletes tokens that are no longer usable: already consumed OR expired
 * (`expires_at` strictly before `now`). Returns the number of rows removed.
 * `now` is an ISO-8601 string. Mirrors the cron path in
 * `db/cleanup.ts#deleteConsumedOrExpiredMagicLinkTokens`, exposed here so the
 * auth layer has a single import surface.
 */
export async function deleteExpired(db: Db, now: string): Promise<number> {
  const deleted = await db
    .delete(magicLinkTokens)
    .where(or(isNotNull(magicLinkTokens.consumedAt), lt(magicLinkTokens.expiresAt, now)))
    .returning({ id: magicLinkTokens.id });
  return deleted.length;
}
