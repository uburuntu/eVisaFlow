import type { Context, SessionFlavor } from "grammy";
import type {
  ConversationFlavor,
  Conversation,
} from "@grammyjs/conversations";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "../utils/logger.js";
import type { Env } from "../env.js";

export interface SessionData {
  userId?: string; // DB user id
}

type BaseContext = Context &
  SessionFlavor<SessionData> & {
    db: SupabaseClient;
    env: Env;
    log: Logger;
  };

export type MyContext = ConversationFlavor<BaseContext>;

export type MyConversation = Conversation<MyContext, MyContext>;
