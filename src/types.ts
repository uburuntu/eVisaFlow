export type TwoFactorMethod = "sms" | "email";

export type IdentityDocument =
  | { type: "passport"; number: string }
  | { type: "nationalId"; number: string }
  | { type: "brc"; number: string }
  | { type: "ukvi"; number: string };

export type DateOfBirth =
  | string
  | {
      day: number;
      month: number;
      year: number;
    };

export type Purpose = "right_to_work" | "right_to_rent" | "immigration_status_other";

export interface Applicant {
  identityDocument: IdentityDocument;
  dateOfBirth: DateOfBirth;
}

export type DiagnosticsMode = "off" | "sanitized" | "raw";
export type PdfOutputMode = "file" | "bytes";

export interface ArtifactRef {
  kind: "pdf" | "snapshot" | "html" | "screenshot";
  path: string;
  sanitized: boolean;
}

export type PdfResult =
  | {
      kind: "file";
      path: string;
      filename: string;
      contentType: "application/pdf";
    }
  | {
      kind: "bytes";
      bytes: Uint8Array;
      filename: string;
      contentType: "application/pdf";
      byteLength: number;
    };

export interface EVisaClientOptions {
  browser?: {
    headless?: boolean;
    userDataDir?: string;
  };
  artifacts?: {
    pdf?:
      | boolean
      | {
          mode?: PdfOutputMode;
          directory?: string;
          path?: string;
        };
    diagnostics?: {
      mode?: DiagnosticsMode;
      directory?: string;
    };
  };
  timeouts?: {
    navigationMs?: number;
    actionMs?: number;
    twoFactorMs?: number;
  };
  onEvent?: (event: EVisaEvent) => void;
  verbose?: boolean;
}

export interface ChallengePreference {
  deliveryMethod?: TwoFactorMethod;
}

export type EVisaChallenge = {
  type: "security_code";
  deliveryMethod: TwoFactorMethod;
  deadlineMs: number;
};

export interface EVisaChallengeContext {
  deadlineMs: number;
  signal: AbortSignal;
}

export type EVisaChallengeResponse = { code: string };

export interface CreateShareCodeRequest {
  applicant: Applicant;
  purpose?: Purpose;
  challengePreference?: ChallengePreference;
  onChallenge: (
    challenge: EVisaChallenge,
    context: EVisaChallengeContext
  ) => Promise<EVisaChallengeResponse>;
}

export interface CreateShareCodeResult {
  shareCode: string;
  validUntil?: string;
  pdf?: PdfResult;
  summary?: {
    name?: string;
    nationality?: string;
    status?: string;
  };
  artifacts?: ArtifactRef[];
}

export type EVisaPhase =
  | "launching"
  | "verifying_identity"
  | "choosing_2fa"
  | "waiting_for_2fa"
  | "viewing_status"
  | "creating_share_code"
  | "downloading_pdf"
  | "completed"
  | "failed";

export type EVisaEvent =
  | { type: "run_started"; phase: "launching" }
  | { type: "phase_changed"; phase: EVisaPhase }
  | {
      type: "page_classified";
      phase: EVisaPhase;
      pageKind: string;
      confidence: number;
      evidence: string[];
    }
  | {
      type: "challenge_required";
      phase: "waiting_for_2fa";
      challenge: EVisaChallenge;
    }
  | { type: "artifact_saved"; phase: EVisaPhase; artifact: ArtifactRef }
  | { type: "completed"; phase: "completed"; result: CreateShareCodeResult }
  | {
      type: "failed";
      phase: "failed";
      error: {
        name: string;
        message: string;
        code?: string;
        retryable?: boolean;
      };
    };
