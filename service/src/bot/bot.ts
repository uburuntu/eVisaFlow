import { conversations } from "@grammyjs/conversations";
import { sequentialize } from "@grammyjs/runner";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Bot, type Context, session } from "grammy";
import type { Env } from "../env.js";
import type { RunEngine } from "../runner/run-engine.js";
import type { Logger } from "../utils/logger.js";
import { registerCommands } from "./commands/index.js";
import type { MyContext, SessionData } from "./context.js";
import { twoFactorMiddleware } from "./middleware/two-factor.js";

function updateSummary(ctx: Context): Record<string, unknown> {
  const update = ctx.update;
  const callbackData = update.callback_query?.data;
  const messageText = update.message?.text;
  return {
    updateId: update.update_id,
    chatId: ctx.chat?.id,
    chatType: ctx.chat?.type,
    telegramId: ctx.from?.id,
    updateKind: update.callback_query
      ? "callback_query"
      : update.message
        ? "message"
        : "other",
    command:
      typeof messageText === "string" && messageText.startsWith("/")
        ? messageText.split(/\s+/, 1)[0]
        : undefined,
    callback:
      typeof callbackData === "string" ? callbackData.split(":", 1)[0] : undefined,
  };
}

const sequentialKey = (ctx: Context): string[] | undefined => {
  const keys = [ctx.chat?.id, ctx.from?.id]
    .filter((value): value is number => value !== undefined)
    .map(String);
  return keys.length ? keys : undefined;
};

export function createBot(
  token: string,
  db: SupabaseClient,
  env: Env,
  log: Logger,
  engine: RunEngine
): Bot<MyContext> {
  const bot = new Bot<MyContext>(token);

  bot.use(sequentialize(sequentialKey));

  // Inject shared services into context
  bot.use((ctx, next) => {
    ctx.db = db;
    ctx.env = env;
    ctx.log = log;
    ctx.engine = engine;
    return next();
  });

  // Session
  bot.use(
    session<SessionData, MyContext>({
      initial: () => ({}),
    })
  );

  // Conversations plugin
  bot.use(conversations());

  // 2FA code interception — must be before command handlers
  bot.use(twoFactorMiddleware);

  // Register all commands and conversations
  registerCommands(bot);

  // Error handler
  bot.catch((err) => {
    log.error({ err: err.error, update: updateSummary(err.ctx) }, "Bot error");
    void err.ctx
      .reply("Something went wrong in the bot handler. Please try the command again.")
      .catch((replyErr) => {
        log.warn(
          { err: replyErr, update: updateSummary(err.ctx) },
          "Failed to send bot error reply"
        );
      });
  });

  return bot;
}
