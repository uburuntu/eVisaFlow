import type {
  Applicant,
  CreateShareCodeResult,
  Purpose,
  TwoFactorMethod,
} from "evisa-flow";
import { EVisaClient } from "evisa-flow";
import { requestCode } from "./two-factor-store.js";

export interface RunRequest {
  requestId: string;
  applicant: Applicant;
  purpose: Purpose;
  twoFactorMethod?: TwoFactorMethod;
  outputDir: string;
  headless: boolean;
  telegramId: number;
  memberName: string;
  /** Called when 2FA is needed — use this to send the Telegram prompt. */
  onTwoFactorNeeded: (method: TwoFactorMethod) => Promise<void>;
}

export async function executeRun(request: RunRequest): Promise<CreateShareCodeResult> {
  const client = new EVisaClient({
    browser: { headless: request.headless },
    artifacts: {
      pdf: { directory: request.outputDir },
      diagnostics: { mode: "off" },
    },
  });

  return client.createShareCode({
    applicant: request.applicant,
    purpose: request.purpose,
    challengePreference: {
      deliveryMethod: request.twoFactorMethod,
    },
    onChallenge: async (challenge, context) => {
      await request.onTwoFactorNeeded(challenge.deliveryMethod);
      const code = await requestCode(
        request.requestId,
        request.telegramId,
        challenge.deliveryMethod,
        request.memberName,
        context.deadlineMs,
        context.signal
      );
      return { code };
    },
  });
}
