import { Bot, session } from "grammy";
import { conversations } from "@grammyjs/conversations";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MyContext, SessionData } from "./context.js";
import type { Logger } from "../utils/logger.js";
import type { Env } from "../env.js";
import { registerCommands } from "./commands/index.js";
import { twoFactorMiddleware } from "./middleware/two-factor.js";

export function createBot(
  token: string,
  db: SupabaseClient,
  env: Env,
  log: Logger,
): Bot<MyContext> {
  const bot = new Bot<MyContext>(token);

  // Inject shared services into context
  bot.use((ctx, next) => {
    ctx.db = db;
    ctx.env = env;
    ctx.log = log;
    return next();
  });

  // Session
  bot.use(
    session<SessionData, MyContext>({
      initial: () => ({}),
    }),
  );

  // Conversations plugin
  bot.use(conversations());

  // 2FA code interception — must be before command handlers
  bot.use(twoFactorMiddleware);

  // Register all commands and conversations
  registerCommands(bot);

  // Error handler
  bot.catch((err) => {
    log.error({ err: err.error, update: err.ctx.update }, "Bot error");
  });

  return bot;
}
