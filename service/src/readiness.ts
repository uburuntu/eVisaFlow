import type { Bot } from "grammy";
import type { MyContext } from "./bot/context.js";
import type { Db } from "./db/client.js";

async function assertNoError(label: string, error: unknown): Promise<void> {
  if (error) {
    throw new Error(`${label} readiness check failed`, { cause: error });
  }
}

export async function assertSupabaseReady(db: Db): Promise<void> {
  const users = await db
    .from("users")
    .select("id", { count: "exact", head: true })
    .limit(1);
  await assertNoError("users table", users.error);

  const runs = await db
    .from("runs")
    .select("id,encrypted_share_code,error_code", { count: "exact", head: true })
    .limit(1);
  await assertNoError("runs schema", runs.error);

  const events = await db
    .from("run_events")
    .select("id", { count: "exact", head: true })
    .limit(1);
  await assertNoError("run_events table", events.error);
}

export async function assertTelegramReady(
  bot: Bot<MyContext>
): Promise<string | undefined> {
  const me = await bot.api.getMe();
  return me.username;
}
