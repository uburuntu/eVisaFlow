import type { NextFunction } from "grammy";
import { hasPending, submitCode } from "../../runner/two-factor-store.js";
import type { MyContext } from "../context.js";

export async function twoFactorMiddleware(
  ctx: MyContext,
  next: NextFunction
): Promise<void> {
  if (ctx.message?.text && ctx.from) {
    const text = ctx.message.text.trim();
    const chatId = ctx.chat?.id;
    // Intercept messages that look like 2FA codes (4-8 digits)
    if (
      chatId !== undefined &&
      /^\d{4,8}$/.test(text) &&
      hasPending(ctx.from.id, chatId)
    ) {
      const accepted = submitCode({
        telegramId: ctx.from.id,
        chatId,
        code: text,
        replyToMessageId: ctx.message.reply_to_message?.message_id,
      });
      if (!accepted) {
        await ctx.reply(
          "Reply to the active 2FA prompt so I know which run this code belongs to."
        );
        return;
      }
      // Delete the user's message containing the code
      try {
        await ctx.api.deleteMessage(chatId, ctx.message.message_id);
      } catch {
        // May lack permissions
      }
      await ctx.reply("Code received, processing...");
      return;
    }
  }
  await next();
}
