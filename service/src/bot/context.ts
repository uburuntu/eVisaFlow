import type { Conversation, ConversationFlavor } from "@grammyjs/conversations";
import type { Context, SessionFlavor } from "grammy";
import type { Db } from "../db/client.js";
import type { Env } from "../env.js";
import type { RunEngine } from "../runner/run-engine.js";
import type { Logger } from "../utils/logger.js";
import type { TwoFactorAdapter } from "./two-factor-adapter.js";

export interface SessionData {
  userId?: string; // DB user id
}

type BaseContext = Context &
  SessionFlavor<SessionData> & {
    db: Db;
    env: Env;
    log: Logger;
    /** Shared single run engine instance driving every queued run. */
    engine: RunEngine;
    /** Telegram 2FA reply matcher bridging incoming codes to the engine. */
    twoFactor: TwoFactorAdapter;
  };

export type MyContext = ConversationFlavor<BaseContext>;

export type MyConversation = Conversation<MyContext, MyContext>;
