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

export type DiagnosticsMode = "off" | "sanitized" | "raw" | "sanitized_on_failure";
export type PdfOutputMode = "file" | "bytes";
export type HtmlOutputMode = "file" | "bytes";

export type PdfArtifactOptions =
  | boolean
  | {
      mode?: "file";
      directory?: string;
      path?: string;
    }
  | {
      mode: "bytes";
      maxBytes?: number;
      directory?: never;
      path?: never;
    };

export type HtmlArtifactOptions =
  | boolean
  | {
      mode?: "file";
      directory?: string;
      path?: string;
      maxBytes?: number;
      inlineImages?: boolean;
      inlineStyles?: boolean;
    }
  | {
      mode: "bytes";
      maxBytes?: number;
      inlineImages?: boolean;
      inlineStyles?: boolean;
      directory?: never;
      path?: never;
    };

export type CheckerArtifactOptions =
  | boolean
  | {
      html?: HtmlArtifactOptions;
      pdf?: PdfArtifactOptions;
    };

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

export type HtmlResult =
  | {
      kind: "file";
      path: string;
      filename: string;
      contentType: "text/html";
      standalone: boolean;
    }
  | {
      kind: "bytes";
      bytes: Uint8Array;
      filename: string;
      contentType: "text/html";
      byteLength: number;
      standalone: boolean;
    };

export interface EVisaClientOptions {
  browser?: {
    headless?: boolean;
    userDataDir?: string;
  };
  artifacts?: {
    pdf?: PdfArtifactOptions;
    checker?: CheckerArtifactOptions;
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

export type ShareCodeCheckPurpose =
  | "driving_licence"
  | "student_loan"
  | "education_or_training"
  | "travel"
  | "health_insurance_card"
  | "personal_finance"
  | "homelessness_or_council_housing"
  | "other";

export interface ShareCodeCheckDetails {
  jobTitle?: string;
  organisation?: string;
  purpose?: ShareCodeCheckPurpose;
  otherPurpose?: string;
}

export interface VerifyShareCodeRequest {
  shareCode: string;
  dateOfBirth: DateOfBirth;
  checkDetails?: ShareCodeCheckDetails;
  signal?: AbortSignal;
}

export interface VerifiedStatusSummary {
  name?: string;
  dateOfBirth?: string;
  nationality?: string;
  status?: string;
  validFrom?: string;
  validUntil?: string;
  checkDate?: string;
  checkReferenceNumber?: string;
  checkPurpose?: string;
  checkerJobTitle?: string;
  checkerOrganisation?: string;
  can?: string[];
  cannot?: string[];
}

export interface VerifyShareCodeResult {
  shareCode: string;
  summary?: VerifiedStatusSummary;
  html?: HtmlResult;
  pdf?: PdfResult;
  artifacts?: ArtifactRef[];
}

export interface CreateShareCodeRequest {
  applicant: Applicant;
  purpose?: Purpose;
  challengePreference?: ChallengePreference;
  checkDetails?: ShareCodeCheckDetails;
  signal?: AbortSignal;
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
  checker?: VerifyShareCodeResult;
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
  | "checking_status"
  | "capturing_checker_html"
  | "downloading_checker_pdf"
  | "completed"
  | "failed";

export type EVisaTimingOperation =
  | "browser_launch"
  | "navigate"
  | "page_snapshot"
  | "step"
  | "diagnostic_capture"
  | "checker"
  | "artifact"
  | "run";

export type EVisaCompletedResult = CreateShareCodeResult | VerifyShareCodeResult;

export type EVisaEvent =
  | { type: "run_started"; phase: "launching" }
  | { type: "phase_changed"; phase: EVisaPhase }
  | {
      type: "timing";
      phase: EVisaPhase;
      operation: EVisaTimingOperation;
      durationMs: number;
      stepId?: string;
      pageKind?: string;
      url?: string;
    }
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
  | { type: "completed"; phase: "completed"; result: EVisaCompletedResult }
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

export type AuthorityBasis = "self" | "parent_or_guardian" | "authorised_proxy";

export type MobileRunStatus =
  | "queued"
  | "running"
  | "awaiting_2fa"
  | "packaging"
  | "succeeded"
  | "partial_success"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "expired";

export type MobileArtifactKind = "evisa_pdf" | "checker_html" | "checker_pdf";

export type MobileEntitlement = "free" | "evisaflow_pro";

export type MobileServiceStatus = "available" | "maintenance";

export interface MobileProfile {
  id: string;
  displayName: string;
  applicant: Applicant;
  preferredTwoFactorMethod: TwoFactorMethod;
  authorityBasis: AuthorityBasis;
  attestedAt: string;
  termsVersion: string;
  lastPurpose?: Purpose;
  createdAt: string;
  updatedAt: string;
}

export interface MobileRunCreateRequest {
  clientRunId: string;
  profileId: string;
  applicant: Applicant;
  purpose: Purpose;
  preferredTwoFactorMethod: TwoFactorMethod;
  authorityBasis: AuthorityBasis;
  attestedAt: string;
  termsVersion: string;
}

export interface MobileArtifactDescriptor {
  id: string;
  kind: MobileArtifactKind;
  filename: string;
  contentType: "application/pdf" | "text/html";
  byteLength: number;
  sha256: string;
}

export interface MobileRunSnapshot {
  id: string;
  clientRunId: string;
  profileId: string;
  purpose: Purpose;
  status: MobileRunStatus;
  phase?: EVisaPhase;
  challenge?: EVisaChallenge;
  retryable?: boolean;
  errorCode?: string;
  artifacts?: MobileArtifactDescriptor[];
  createdAt: string;
  updatedAt: string;
}

export interface MobileRunClaimResult {
  shareCode: string;
  validUntil?: string;
  artifacts: MobileArtifactDescriptor[];
}

export interface MobileMe {
  userId: string;
  entitlement: MobileEntitlement;
  profileLimit: number;
  activeProfileCount: number;
  successfulRunCount: number;
  remainingFreeRuns: number | null;
  serviceStatus: MobileServiceStatus;
  serviceMessage?: string;
}

export interface MobileProfileSlotRequest {
  profileId: string;
}

export interface MobileChallengeSubmission {
  code: string;
}

export interface MobileRunEvent {
  id: number;
  runId: string;
  type: string;
  phase?: EVisaPhase;
  message?: string;
  createdAt: string;
}

export interface MobileApiError {
  code: string;
  message: string;
  retryable: boolean;
}
