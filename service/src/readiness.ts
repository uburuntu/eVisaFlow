import { sql } from "drizzle-orm";
import type { Bot } from "grammy";
import type { MyContext } from "./bot/context.js";
import type { Db } from "./db/client.js";
import { runEvents, runs, users } from "./db/schema.js";

async function assertQueryable(label: string, query: Promise<unknown>): Promise<void> {
  try {
    await query;
  } catch (error) {
    throw new Error(`${label} readiness check failed`, { cause: error });
  }
}

/**
 * Verifies database connectivity and that the tables the service depends on are
 * present and queryable. Each probe is a cheap `LIMIT 1` select so it touches no
 * rows of consequence; together they confirm the schema is migrated far enough
 * for the bot/engine to operate.
 */
export async function assertDbReady(db: Db): Promise<void> {
  await assertQueryable("users table", db.select({ ok: users.id }).from(users).limit(1));
  await assertQueryable(
    "runs schema",
    db
      .select({
        id: runs.id,
        encryptedShareCode: runs.encryptedShareCode,
        errorCode: runs.errorCode,
      })
      .from(runs)
      .limit(1)
  );
  await assertQueryable(
    "run_events table",
    db.select({ ok: runEvents.id }).from(runEvents).limit(1)
  );
  // Final connectivity sanity check independent of any single table.
  await assertQueryable("database connectivity", db.execute(sql`select 1`));
}

export async function assertTelegramReady(
  bot: Bot<MyContext>
): Promise<string | undefined> {
  const me = await bot.api.getMe();
  return me.username;
}
