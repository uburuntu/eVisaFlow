import type { MyContext, MyConversation } from "../context.js";
import { encrypt } from "../../crypto/encryption.js";
import {
  addFamilyMember,
  countActiveFamilyMembers,
} from "../../db/family-members.js";
import { getUserByTelegramId } from "../../db/users.js";
import { InlineKeyboard } from "grammy";

const AUTH_TYPES = [
  { label: "Passport", value: "passport" },
  { label: "National ID", value: "nationalId" },
  { label: "BRC (Biometric Residence Card)", value: "brc" },
  { label: "UKVI Number", value: "ukvi" },
] as const;

const TWO_FA_METHODS = [
  { label: "SMS", value: "sms" },
  { label: "Email", value: "email" },
] as const;

const DOC_LABELS: Record<string, string> = {
  passport: "passport number",
  nationalId: "national ID number",
  brc: "BRC card number",
  ukvi: "UKVI customer number",
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function addMemberConversation(
  conversation: MyConversation,
  ctx: MyContext,
): Promise<void> {
  // Inside a conversation, ctx is an "inside context object" that does NOT
  // have middleware-injected properties (db, env, log). Access the "outside
  // context" via conversation.external((ctx) => ...) — its ctx parameter
  // carries all middleware properties. Results must be serializable.

  // Track intermediate message IDs for cleanup after completion.
  const cleanupIds: number[] = [];

  const user = await conversation.external((ctx) =>
    getUserByTelegramId(ctx.db, ctx.from!.id),
  );
  if (!user) {
    await ctx.reply("Please /start first.");
    return;
  }

  const count = await conversation.external((ctx) =>
    countActiveFamilyMembers(ctx.db, user.id),
  );
  if (count >= 6) {
    await ctx.reply(
      "You already have <b>6/6</b> family members (the maximum).\nRemove one with /members first.",
      { parse_mode: "HTML" },
    );
    return;
  }

  // 1. Display name
  const step1 = await ctx.reply(
    "<b>Step 1/5 — Name</b>\n\nWhat name should I use for this person?\ne.g. Dad, Mum, Alan",
    { parse_mode: "HTML" },
  );
  cleanupIds.push(step1.message_id);
  const nameMsg = await conversation.waitFor("message:text");
  cleanupIds.push(nameMsg.message.message_id);
  const displayName = nameMsg.message.text.trim();

  // 2. Auth type
  const authKb = new InlineKeyboard();
  for (const t of AUTH_TYPES) {
    authKb.text(t.label, `add_auth:${t.value}`).row();
  }
  const step2 = await ctx.reply(
    `<b>Step 2/5 — Document Type</b>\n\nWhich document does <b>${escapeHtml(displayName)}</b> use?`,
    { parse_mode: "HTML", reply_markup: authKb },
  );
  cleanupIds.push(step2.message_id);
  const authCb = await conversation.waitForCallbackQuery(/^add_auth:/);
  const authType = authCb.callbackQuery.data.replace("add_auth:", "");
  await authCb.answerCallbackQuery();

  // 3. Document number
  const docLabel = DOC_LABELS[authType] ?? "document number";
  const step3 = await ctx.reply(
    `<b>Step 3/5 — Document Number</b>\n\nEnter <b>${escapeHtml(displayName)}</b>'s ${docLabel}:`,
    { parse_mode: "HTML" },
  );
  cleanupIds.push(step3.message_id);
  const docMsg = await conversation.waitFor("message:text");
  cleanupIds.push(docMsg.message.message_id);
  const docNumber = docMsg.message.text.trim();

  // 4. Date of birth
  const step4 = await ctx.reply(
    `<b>Step 4/5 — Date of Birth</b>\n\nEnter <b>${escapeHtml(displayName)}</b>'s date of birth:\nFormat: DD-MM-YYYY (e.g. 15-06-1990)`,
    { parse_mode: "HTML" },
  );
  cleanupIds.push(step4.message_id);
  let dobDay: number, dobMonth: number, dobYear: number;
  while (true) {
    const dobMsg = await conversation.waitFor("message:text");
    cleanupIds.push(dobMsg.message.message_id);
    const match = dobMsg.message.text.trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (match) {
      dobDay = parseInt(match[1], 10);
      dobMonth = parseInt(match[2], 10);
      dobYear = parseInt(match[3], 10);
      if (dobDay >= 1 && dobDay <= 31 && dobMonth >= 1 && dobMonth <= 12 && dobYear >= 1900) {
        break;
      }
    }
    const retryMsg = await ctx.reply(
      "Invalid format. Please use <b>DD-MM-YYYY</b> (e.g. 15-06-1990):",
      { parse_mode: "HTML" },
    );
    cleanupIds.push(retryMsg.message_id);
  }

  // 5. 2FA method
  const tfaKb = new InlineKeyboard();
  for (const m of TWO_FA_METHODS) {
    tfaKb.text(m.label, `add_2fa:${m.value}`);
  }
  const step5 = await ctx.reply(
    `<b>Step 5/5 — Security Code Delivery</b>\n\nHow does <b>${escapeHtml(displayName)}</b> receive security codes?`,
    { parse_mode: "HTML", reply_markup: tfaKb },
  );
  cleanupIds.push(step5.message_id);
  const tfaCb = await conversation.waitForCallbackQuery(/^add_2fa:/);
  const twoFaMethod = tfaCb.callbackQuery.data.replace("add_2fa:", "");
  await tfaCb.answerCallbackQuery();

  // Save — use conversation.external to access ctx.db and ctx.env from the
  // outside context, since the inside ctx doesn't have middleware properties.
  const encryptedDoc = await conversation.external((ctx) =>
    encrypt(docNumber, ctx.env.ENCRYPTION_KEY),
  );
  await conversation.external((ctx) =>
    addFamilyMember(ctx.db, {
      user_id: user.id,
      display_name: displayName,
      auth_type: authType,
      encrypted_doc_number: encryptedDoc,
      dob_day: dobDay!,
      dob_month: dobMonth!,
      dob_year: dobYear!,
      preferred_2fa_method: twoFaMethod,
      purpose: "immigration_status_other",
    }),
  );

  // Delete all intermediate messages
  await conversation.external(async (ctx) => {
    await Promise.allSettled(
      cleanupIds.map((id) => ctx.api.deleteMessage(ctx.chat!.id, id)),
    );
  });

  const maskedDoc = docNumber.length > 3
    ? "••" + docNumber.slice(-3)
    : "•••";

  const typeLabel = AUTH_TYPES.find((t) => t.value === authType)?.label ?? authType;
  const dobStr = `${String(dobDay!).padStart(2, "0")}-${String(dobMonth!).padStart(2, "0")}-${dobYear!}`;

  await ctx.reply(
    [
      `<b>${escapeHtml(displayName)}</b> added successfully!`,
      "",
      `  Document: ${typeLabel}  <code>${maskedDoc}</code>`,
      `  DOB: ${dobStr}`,
      `  2FA: ${twoFaMethod.toUpperCase()}`,
      "",
      `You now have <b>${count + 1}/6</b> family members.`,
      "",
      "Use /run to get a share code or /add to add another.",
    ].join("\n"),
    { parse_mode: "HTML" },
  );
}
