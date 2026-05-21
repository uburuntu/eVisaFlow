import type { NextFunction } from "grammy";
import { hasPending, submitCode } from "../../runner/two-factor-store.js";
import type { MyContext } from "../context.js";

const CODE_ACK_DELETE_DELAY_MS = 30_000;

function scheduleMessageDeletion(
  ctx: MyContext,
  chatId: number,
  messageId: number
): void {
  const timer = setTimeout(() => {
    void ctx.api.deleteMessage(chatId, messageId).catch(() => {
      // Message may already be gone, or the bot may lack permission.
    });
  }, CODE_ACK_DELETE_DELAY_MS);
  timer.unref?.();
}

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
      const ack = await ctx.reply("Code received, processing...");
      scheduleMessageDeletion(ctx, chatId, ack.message_id);
      return;
    }
  }
  await next();
}
