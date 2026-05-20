import type {
  Applicant,
  CreateShareCodeResult,
  DiagnosticsMode,
  EVisaEvent,
  Purpose,
  TwoFactorMethod,
} from "evisa-flow";
import { EVisaClient } from "evisa-flow";
import { cancelRequest, requestCode, setPromptMessageId } from "./two-factor-store.js";

export interface RunRequest {
  requestId: string;
  applicant: Applicant;
  purpose: Purpose;
  twoFactorMethod?: TwoFactorMethod;
  headless: boolean;
  diagnosticsMode: DiagnosticsMode;
  signal?: AbortSignal;
  telegramId: number;
  chatId: number;
  memberName: string;
  onEvent?: (event: EVisaEvent) => void;
  /** Called when 2FA is needed — use this to send the Telegram prompt. */
  onTwoFactorNeeded: (method: TwoFactorMethod) => Promise<number | undefined>;
}

export async function executeRun(request: RunRequest): Promise<CreateShareCodeResult> {
  const client = new EVisaClient({
    browser: { headless: request.headless },
    onEvent: request.onEvent,
    artifacts: {
      pdf: { mode: "bytes" },
      checker: {
        html: { mode: "bytes" },
        pdf: { mode: "bytes" },
      },
      diagnostics: { mode: request.diagnosticsMode },
    },
  });

  return client.createShareCode({
    applicant: request.applicant,
    purpose: request.purpose,
    signal: request.signal,
    challengePreference: {
      deliveryMethod: request.twoFactorMethod,
    },
    onChallenge: async (challenge, context) => {
      const codePromise = requestCode({
        requestId: request.requestId,
        telegramId: request.telegramId,
        chatId: request.chatId,
        method: challenge.deliveryMethod,
        memberName: request.memberName,
        deadlineMs: context.deadlineMs,
        signal: context.signal,
      });
      codePromise.catch(() => {});

      try {
        const promptMessageId = await request.onTwoFactorNeeded(challenge.deliveryMethod);
        if (promptMessageId !== undefined) {
          setPromptMessageId(request.requestId, promptMessageId);
        }
      } catch (error) {
        cancelRequest(request.requestId, "Failed to send 2FA prompt");
        throw error;
      }

      const code = await codePromise;
      return { code };
    },
  });
}
