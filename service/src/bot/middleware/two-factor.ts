import type { NextFunction } from "grammy";
import { hasPending, submitCode } from "../../runner/two-factor-store.js";
import type { MyContext } from "../context.js";

export async function twoFactorMiddleware(
  ctx: MyContext,
  next: NextFunction
): Promise<void> {
  if (ctx.message?.text && ctx.from) {
    const text = ctx.message.text.trim();
    // Intercept messages that look like 2FA codes (4-8 digits)
    if (/^\d{4,8}$/.test(text) && hasPending(ctx.from.id)) {
      submitCode(ctx.from.id, text);
      // Delete the user's message containing the code
      const chatId = ctx.chat?.id;
      if (chatId !== undefined) {
        try {
          await ctx.api.deleteMessage(chatId, ctx.message.message_id);
        } catch {
          // May lack permissions
        }
      }
      await ctx.reply("Code received, processing...");
      return;
    }
  }
  await next();
}
