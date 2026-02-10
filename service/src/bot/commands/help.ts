import type { MyContext } from "../context.js";

export async function helpCommand(ctx: MyContext): Promise<void> {
  await ctx.reply(
    [
      "<b>eVisa Share Code Bot</b>",
      "",
      "/add — Add a family member (up to 6)",
      "/members — View, edit, or remove members",
      "/run — Get share codes for one or all members",
      "/help — Show this message",
      "",
      "When I run the eVisa flow, I'll ask you to enter " +
        "2FA codes sent to each family member's phone or email. " +
        "Have their devices nearby!",
    ].join("\n"),
    { parse_mode: "HTML" },
  );
}
