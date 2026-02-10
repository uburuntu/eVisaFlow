import { EVisaFlow } from "evisa-flow";
import type {
  Credentials,
  Purpose,
  TwoFactorMethod,
  RunResult,
} from "evisa-flow";
import { requestCode } from "./two-factor-store.js";

export interface RunRequest {
  credentials: Credentials;
  purpose: Purpose;
  outputDir: string;
  headless: boolean;
  telegramId: number;
  memberName: string;
  /** Called when 2FA is needed — use this to send the Telegram prompt. */
  onTwoFactorNeeded: (method: TwoFactorMethod) => Promise<void>;
}

export async function executeRun(request: RunRequest): Promise<RunResult> {
  const flow = new EVisaFlow({
    credentials: request.credentials,
    purpose: request.purpose,
    onTwoFactorRequired: async (method, { deadlineMs }) => {
      // Notify the caller (bot) that 2FA is needed
      await request.onTwoFactorNeeded(method);
      // Wait for the user to submit the code via Telegram
      return requestCode(
        request.telegramId,
        method,
        request.memberName,
        deadlineMs,
      );
    },
    options: {
      headless: request.headless,
      outputDir: request.outputDir,
    },
  });

  return flow.run();
}
