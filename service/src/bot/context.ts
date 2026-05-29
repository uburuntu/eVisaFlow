import type { Conversation, ConversationFlavor } from "@grammyjs/conversations";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Context, SessionFlavor } from "grammy";
import type { Env } from "../env.js";
import type { RunEngine } from "../runner/run-engine.js";
import type { Logger } from "../utils/logger.js";

export interface SessionData {
  userId?: string; // DB user id
}

type BaseContext = Context &
  SessionFlavor<SessionData> & {
    db: SupabaseClient;
    env: Env;
    log: Logger;
    /** Shared single run engine instance driving every queued run. */
    engine: RunEngine;
  };

export type MyContext = ConversationFlavor<BaseContext>;

export type MyConversation = Conversation<MyContext, MyContext>;
