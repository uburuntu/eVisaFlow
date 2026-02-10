import type { Bot } from "grammy";
import { createConversation } from "@grammyjs/conversations";
import type { MyContext } from "../context.js";
import { startCommand } from "./start.js";
import { helpCommand } from "./help.js";
import { addMemberConversation } from "./add.js";
import { membersCommand, registerMemberCallbacks } from "./members.js";
import { runCommand, registerRunCallbacks } from "./run.js";

export function registerCommands(bot: Bot<MyContext>): void {
  // Conversations
  bot.use(createConversation(addMemberConversation, "add-member"));

  // Commands
  bot.command("start", startCommand);
  bot.command("help", helpCommand);
  bot.command("add", async (ctx) => {
    await ctx.conversation.enter("add-member");
  });
  bot.command("members", membersCommand);
  bot.command("run", runCommand);

  // Callback query handlers
  registerMemberCallbacks(bot);
  registerRunCallbacks(bot);

  // Set command menu
  bot.api.setMyCommands([
    { command: "add", description: "Add a family member" },
    { command: "members", description: "View or remove members" },
    { command: "run", description: "Get share codes" },
    { command: "help", description: "Show help" },
  ]).catch(() => {});
}
