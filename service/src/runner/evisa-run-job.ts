import type { CreateShareCodeResult, EVisaClientOptions, EVisaEvent } from "evisa-flow";
import { EVisaClient } from "evisa-flow";
import type { RunJob, RunJobContext } from "./run-engine.js";
import { translateEVisaEvent } from "./run-engine.js";
import { requestCode as defaultRequestCode } from "./two-factor-store.js";

/**
 * The minimal shape the run-job needs from an eVisa client. {@link EVisaClient}
 * satisfies it; tests inject a fake so no Playwright browser is launched.
 */
export interface EVisaRunClient {
  createShareCode(
    request: Parameters<EVisaClient["createShareCode"]>[0]
  ): Promise<CreateShareCodeResult>;
}

export interface CreateEvisaRunJobDeps {
  /**
   * Factory for the eVisa client. Defaults to the real {@link EVisaClient}.
   * Tests pass a fake so the job runs without a real browser.
   */
  createClient?: (options: EVisaClientOptions) => EVisaRunClient;
  /**
   * 2FA code resolver, keyed by `runId`. Defaults to the shared two-factor
   * store. The Telegram-only `telegramId`/`chatId` fields are intentionally
   * omitted — the engine resolves the gate by `runId` alone.
   */
  requestCode?: typeof defaultRequestCode;
}

/**
 * Builds the real {@link RunJob}: the unit of work the run engine executes
 * inside a queue slot. It constructs an {@link EVisaClient} that streams its
 * artifacts as in-memory bytes, drives the GOV.UK flow via `createShareCode`,
 * forwards translated progress events through the run bus, and bridges the human
 * 2FA wait to the shared two-factor store (resolvable by `runId`).
 *
 * Output sealing/encryption and persistence are the engine's responsibility:
 * the job simply returns the {@link CreateShareCodeResult}.
 */
export function createEvisaRunJob(deps: CreateEvisaRunJobDeps = {}): RunJob {
  const createClient =
    deps.createClient ?? ((options: EVisaClientOptions) => new EVisaClient(options));
  const requestCode = deps.requestCode ?? defaultRequestCode;

  return async (ctx: RunJobContext): Promise<CreateShareCodeResult> => {
    const client = createClient({
      browser: { headless: ctx.input.headless },
      artifacts: {
        pdf: { mode: "bytes" },
        checker: {
          html: { mode: "bytes" },
          pdf: { mode: "bytes" },
        },
        diagnostics: { mode: ctx.input.diagnosticsMode },
      },
      onEvent: (event: EVisaEvent) => {
        const runEvent = translateEVisaEvent(event);
        if (runEvent) {
          ctx.publish(runEvent);
        }
      },
    });

    return client.createShareCode({
      applicant: ctx.applicant,
      purpose: ctx.purpose,
      challengePreference: { deliveryMethod: ctx.twoFactorMethod },
      signal: ctx.signal,
      onChallenge: async (challenge, context) => {
        ctx.publish({
          type: "challenge_required",
          method: challenge.deliveryMethod,
          deadlineMs: challenge.deadlineMs,
        });
        const code = await requestCode({
          requestId: ctx.input.runId,
          method: challenge.deliveryMethod,
          memberName: ctx.memberName,
          deadlineMs: context.deadlineMs,
          signal: context.signal,
        });
        return { code };
      },
    });
  };
}
