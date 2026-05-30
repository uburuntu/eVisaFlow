import type { RunEngine } from "../runner/run-engine.js";

/**
 * Telegram-specific 2FA reply matching.
 *
 * The run engine resolves a pending 2FA gate by `runId` alone
 * ({@link RunEngine.submitCode}). Telegram, however, delivers codes as free-text
 * messages that carry only the sender (`telegramId` + `chatId`) and an optional
 * `reply_to_message_id` — never the `runId`. This adapter bridges that gap: it
 * keeps a per-(telegramId, chatId) registry of the active runs awaiting a code
 * (each tagged with the prompt message the bot sent), and translates an incoming
 * reply into the right `engine.submitCode(runId, code)` call.
 *
 * It is the Telegram channel's private mapping; the two-factor store stays
 * channel-agnostic (keyed by `runId`). A web channel needs none of this — it
 * POSTs the `runId` directly.
 */

interface PendingPrompt {
  runId: string;
  /** The bot message the user is expected to reply to, when known. */
  promptMessageId?: number;
}

function routeKey(telegramId: number, chatId: number): string {
  return `${telegramId}:${chatId}`;
}

export interface TwoFactorAdapter {
  /**
   * Record that `runId` is awaiting a 2FA code from `telegramId` in `chatId`,
   * with the prompt message the user should reply to. Called by the run driver
   * on a `challenge_required` event, after the prompt has been sent.
   */
  register(params: {
    telegramId: number;
    chatId: number;
    runId: string;
    promptMessageId: number;
  }): void;
  /** Whether any run is awaiting a code from this user in this chat. */
  hasPending(telegramId: number, chatId: number): boolean;
  /**
   * Route an incoming code to the right run and resolve its gate. Picks the run
   * whose prompt the user replied to; falls back to the sole pending run when
   * the reply target is absent or unmatched and there is exactly one. Returns
   * `false` when nothing could be matched (e.g. ambiguous without a reply), so
   * the caller can ask the user to reply to the active prompt.
   */
  submit(
    telegramId: number,
    chatId: number,
    code: string,
    replyToMessageId?: number
  ): boolean;
  /**
   * Drop any registry entry for `runId`. Called when a run reaches a terminal
   * state so a resolved/failed/cancelled run never lingers in the matcher.
   */
  unregister(runId: string): void;
}

export function createTwoFactorAdapter(engine: RunEngine): TwoFactorAdapter {
  // One slot per (telegramId, chatId); a slot can hold several concurrent runs
  // (e.g. "Run All"), disambiguated by the prompt the user replies to.
  const routes = new Map<string, PendingPrompt[]>();

  function removeRun(runId: string): void {
    for (const [key, prompts] of routes) {
      const next = prompts.filter((prompt) => prompt.runId !== runId);
      if (next.length === 0) {
        routes.delete(key);
      } else if (next.length !== prompts.length) {
        routes.set(key, next);
      }
    }
  }

  return {
    register({ telegramId, chatId, runId, promptMessageId }) {
      const key = routeKey(telegramId, chatId);
      const prompts = routes.get(key) ?? [];
      // A run can re-prompt (e.g. a fresh code); keep a single entry per runId.
      const existing = prompts.find((prompt) => prompt.runId === runId);
      if (existing) {
        existing.promptMessageId = promptMessageId;
      } else {
        prompts.push({ runId, promptMessageId });
      }
      routes.set(key, prompts);
    },

    hasPending(telegramId, chatId) {
      const prompts = routes.get(routeKey(telegramId, chatId));
      return prompts !== undefined && prompts.length > 0;
    },

    submit(telegramId, chatId, code, replyToMessageId) {
      const key = routeKey(telegramId, chatId);
      const prompts = routes.get(key);
      if (!prompts || prompts.length === 0) {
        return false;
      }
      const matched =
        prompts.find(
          (prompt) =>
            prompt.promptMessageId !== undefined &&
            prompt.promptMessageId === replyToMessageId
        ) ?? (prompts.length === 1 ? prompts[0] : undefined);
      if (!matched) {
        return false;
      }
      const accepted = engine.submitCode(matched.runId, code);
      if (accepted) {
        removeRun(matched.runId);
      }
      return accepted;
    },

    unregister(runId) {
      removeRun(runId);
    },
  };
}
