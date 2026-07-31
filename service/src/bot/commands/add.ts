import { InlineKeyboard } from "grammy";
import { encrypt } from "../../crypto/encryption.js";
import { addFamilyMember, countActiveFamilyMembers } from "../../db/family-members.js";
import { getUserByTelegramId } from "../../db/users.js";
import { escapeHtml } from "../../utils/messages.js";
import type { MyContext, MyConversation } from "../context.js";

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

type AuthType = (typeof AUTH_TYPES)[number]["value"];
type TwoFaMethod = (typeof TWO_FA_METHODS)[number]["value"];

const DOC_LABELS: Record<AuthType, string> = {
  passport: "passport number",
  nationalId: "national ID number",
  brc: "BRC card number",
  ukvi: "UKVI customer number",
};

class AddCancelled extends Error {
  constructor() {
    super("Add member cancelled");
    this.name = "AddCancelled";
  }
}

function cancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Cancel", "add_cancel");
}

function authKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const type of AUTH_TYPES) {
    kb.text(type.label, `add_auth:${type.value}`).row();
  }
  kb.text("Cancel", "add_cancel");
  return kb;
}

function twoFaKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const method of TWO_FA_METHODS) {
    kb.text(method.label, `add_2fa:${method.value}`);
  }
  kb.row().text("Cancel", "add_cancel");
  return kb;
}

function isAuthType(value: string): value is AuthType {
  return AUTH_TYPES.some((type) => type.value === value);
}

function isTwoFaMethod(value: string): value is TwoFaMethod {
  return TWO_FA_METHODS.some((method) => method.value === value);
}

function validateDisplayName(value: string): string | undefined {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed === "" || trimmed.startsWith("/")) {
    return undefined;
  }
  if (trimmed.length > 60) {
    return undefined;
  }
  return trimmed;
}

function validateDocumentNumber(value: string): string | undefined {
  const trimmed = value.trim().replace(/\s+/g, "");
  if (trimmed.startsWith("/") || trimmed.length < 3 || trimmed.length > 64) {
    return undefined;
  }
  if (!/^[A-Za-z0-9-]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed.toUpperCase();
}

function parseDob(
  value: string
): { day: number; month: number; year: number } | undefined {
  const match = value.trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!match) {
    return undefined;
  }

  const day = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const year = Number.parseInt(match[3], 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  const today = new Date();
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    year < 1900 ||
    date.getTime() >
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  ) {
    return undefined;
  }

  return { day, month, year };
}

async function deleteMessages(
  conversation: MyConversation,
  chatId: number,
  messageIds: number[]
): Promise<void> {
  const ids = Array.from(new Set(messageIds));
  await conversation.external(async (ctx) => {
    await Promise.allSettled(ids.map((id) => ctx.api.deleteMessage(chatId, id)));
  });
}

function assertNotCancel(text: string): void {
  if (text.trim().toLowerCase() === "/cancel") {
    throw new AddCancelled();
  }
}

export async function addMemberConversation(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  const cleanupIds: number[] = [];
  const telegramId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (telegramId === undefined || chatId === undefined) {
    await ctx.reply("Please use /add from a Telegram chat.");
    return;
  }

  let shouldSendCancelled = false;

  try {
    const user = await conversation.external((ctx) =>
      getUserByTelegramId(ctx.db, telegramId)
    );
    if (!user) {
      await ctx.reply("Please /start first.");
      return;
    }

    const count = await conversation.external((ctx) =>
      countActiveFamilyMembers(ctx.db, user.id)
    );
    if (count >= 6) {
      await ctx.reply(
        "You already have <b>6/6</b> family members (the maximum).\nRemove one with /members first.",
        { parse_mode: "HTML" }
      );
      return;
    }

    const step1 = await ctx.reply(
      "<b>Step 1/5 - Name</b>\n\nWhat name should I use for this person?\ne.g. Dad, Mum, Alan\n\nSend /cancel to stop.",
      { parse_mode: "HTML" }
    );
    cleanupIds.push(step1.message_id);

    let displayName: string | undefined;
    while (displayName === undefined) {
      const nameMsg = await conversation.waitFor("message:text");
      cleanupIds.push(nameMsg.message.message_id);
      await deleteMessages(conversation, chatId, [nameMsg.message.message_id]);
      assertNotCancel(nameMsg.message.text);
      displayName = validateDisplayName(nameMsg.message.text);
      if (!displayName) {
        const retryMsg = await ctx.reply(
          "Use a short name without commands, for example Dad or Alan.",
          { reply_markup: cancelKeyboard() }
        );
        cleanupIds.push(retryMsg.message_id);
      }
    }

    const step2 = await ctx.reply(
      `<b>Step 2/5 - Document Type</b>\n\nWhich document does <b>${escapeHtml(displayName)}</b> use?`,
      { parse_mode: "HTML", reply_markup: authKeyboard() }
    );
    cleanupIds.push(step2.message_id);
    const authCb = await conversation.waitForCallbackQuery(/^(add_auth:|add_cancel$)/);
    const authData = authCb.callbackQuery.data;
    await authCb.answerCallbackQuery();
    if (authData === "add_cancel") {
      throw new AddCancelled();
    }
    const authTypeValue = authData.replace("add_auth:", "");
    if (!isAuthType(authTypeValue)) {
      throw new Error(`Unsupported auth type: ${authTypeValue}`);
    }
    const authType = authTypeValue;

    const docLabel = DOC_LABELS[authType];
    const step3 = await ctx.reply(
      `<b>Step 3/5 - Document Number</b>\n\nEnter <b>${escapeHtml(displayName)}</b>'s ${docLabel}:`,
      { parse_mode: "HTML" }
    );
    cleanupIds.push(step3.message_id);

    let docNumber: string | undefined;
    while (docNumber === undefined) {
      const docMsg = await conversation.waitFor("message:text");
      cleanupIds.push(docMsg.message.message_id);
      await deleteMessages(conversation, chatId, [docMsg.message.message_id]);
      assertNotCancel(docMsg.message.text);
      docNumber = validateDocumentNumber(docMsg.message.text);
      if (!docNumber) {
        const retryMsg = await ctx.reply(
          "That document number does not look right. Use letters, numbers, and hyphens only.",
          { reply_markup: cancelKeyboard() }
        );
        cleanupIds.push(retryMsg.message_id);
      }
    }

    const step4 = await ctx.reply(
      `<b>Step 4/5 - Date of Birth</b>\n\nEnter <b>${escapeHtml(displayName)}</b>'s date of birth:\nFormat: DD-MM-YYYY`,
      { parse_mode: "HTML" }
    );
    cleanupIds.push(step4.message_id);

    let dob: { day: number; month: number; year: number } | undefined;
    while (dob === undefined) {
      const dobMsg = await conversation.waitFor("message:text");
      cleanupIds.push(dobMsg.message.message_id);
      await deleteMessages(conversation, chatId, [dobMsg.message.message_id]);
      assertNotCancel(dobMsg.message.text);
      dob = parseDob(dobMsg.message.text);
      if (!dob) {
        const retryMsg = await ctx.reply(
          "Use a real calendar date in <b>DD-MM-YYYY</b> format.",
          { parse_mode: "HTML", reply_markup: cancelKeyboard() }
        );
        cleanupIds.push(retryMsg.message_id);
      }
    }

    const step5 = await ctx.reply(
      `<b>Step 5/5 - Security Code Delivery</b>\n\nHow does <b>${escapeHtml(displayName)}</b> receive security codes?`,
      { parse_mode: "HTML", reply_markup: twoFaKeyboard() }
    );
    cleanupIds.push(step5.message_id);
    const tfaCb = await conversation.waitForCallbackQuery(/^(add_2fa:|add_cancel$)/);
    const tfaData = tfaCb.callbackQuery.data;
    await tfaCb.answerCallbackQuery();
    if (tfaData === "add_cancel") {
      throw new AddCancelled();
    }
    const twoFaValue = tfaData.replace("add_2fa:", "");
    if (!isTwoFaMethod(twoFaValue)) {
      throw new Error(`Unsupported 2FA method: ${twoFaValue}`);
    }
    const twoFaMethod = twoFaValue;

    const encryptedDoc = await conversation.external((ctx) =>
      encrypt(docNumber, ctx.env.ENCRYPTION_KEY)
    );
    await conversation.external((ctx) =>
      addFamilyMember(ctx.db, {
        user_id: user.id,
        display_name: displayName,
        auth_type: authType,
        encrypted_doc_number: encryptedDoc,
        dob_day: dob.day,
        dob_month: dob.month,
        dob_year: dob.year,
        preferred_2fa_method: twoFaMethod,
        purpose: "immigration_status_other",
      })
    );

    const maskedDoc = docNumber.length > 3 ? `••${docNumber.slice(-3)}` : "•••";
    const typeLabel =
      AUTH_TYPES.find((type) => type.value === authType)?.label ?? authType;

    await ctx.reply(
      [
        `<b>${escapeHtml(displayName)}</b> added successfully.`,
        "",
        `Document: ${typeLabel} <code>${maskedDoc}</code>`,
        `2FA: ${twoFaMethod.toUpperCase()}`,
        "",
        `You now have <b>${count + 1}/6</b> family members.`,
        "",
        "Use /run to get a share code or /add to add another.",
      ].join("\n"),
      { parse_mode: "HTML" }
    );
  } catch (err) {
    if (err instanceof AddCancelled) {
      shouldSendCancelled = true;
      return;
    }
    throw err;
  } finally {
    await deleteMessages(conversation, chatId, cleanupIds);
    if (shouldSendCancelled) {
      await ctx.reply("Add member cancelled.");
    }
  }
}
