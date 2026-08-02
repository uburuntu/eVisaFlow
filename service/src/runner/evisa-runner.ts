import type {
  Applicant,
  CreateShareCodeResult,
  DiagnosticsMode,
  EVisaChallenge,
  EVisaChallengeContext,
  EVisaChallengeResponse,
  EVisaEvent,
  Purpose,
  TwoFactorMethod,
} from "evisa-flow";
import { EVisaClient } from "evisa-flow";

export interface RunRequest {
  applicant: Applicant;
  purpose: Purpose;
  twoFactorMethod?: TwoFactorMethod;
  headless: boolean;
  diagnosticsMode: DiagnosticsMode;
  signal?: AbortSignal;
  onEvent?: (event: EVisaEvent) => void;
  onChallenge: (
    challenge: EVisaChallenge,
    context: EVisaChallengeContext
  ) => Promise<EVisaChallengeResponse>;
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
    onChallenge: request.onChallenge,
  });
}
