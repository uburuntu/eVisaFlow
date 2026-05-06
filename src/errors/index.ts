import type { PageKind } from "../core/page-classifier.js";
import type { ArtifactRef, EVisaPhase } from "../types.js";

export type EVisaErrorCode =
  | "PAGE_DETECTION_FAILED"
  | "SELECTOR_NOT_FOUND"
  | "TWO_FACTOR_TIMEOUT"
  | "AUTHENTICATION_FAILED"
  | "SESSION_EXPIRED"
  | "SERVICE_UNAVAILABLE"
  | "BROWSER_LAUNCH_FAILED"
  | "CONFIG_INVALID"
  | "FLOW_FAILED";

export interface EVisaErrorDetails {
  code?: EVisaErrorCode;
  retryable?: boolean;
  phase?: EVisaPhase;
  pageKind?: PageKind;
  artifactRefs?: ArtifactRef[];
  cause?: unknown;
}

export class EVisaError extends Error {
  readonly code: EVisaErrorCode;
  readonly retryable: boolean;
  readonly phase?: EVisaPhase;
  readonly pageKind?: PageKind;
  readonly artifactRefs: ArtifactRef[];

  constructor(message: string, details: EVisaErrorDetails = {}) {
    super(message, { cause: details.cause });
    this.name = new.target.name;
    this.code = details.code ?? "FLOW_FAILED";
    this.retryable = details.retryable ?? false;
    this.phase = details.phase;
    this.pageKind = details.pageKind;
    this.artifactRefs = details.artifactRefs ?? [];
  }
}

export class PageDetectionError extends EVisaError {
  constructor(message: string, details: EVisaErrorDetails = {}) {
    super(message, {
      code: "PAGE_DETECTION_FAILED",
      retryable: false,
      ...details,
    });
  }
}

export class SelectorNotFoundError extends EVisaError {
  constructor(message: string, details: EVisaErrorDetails = {}) {
    super(message, {
      code: "SELECTOR_NOT_FOUND",
      retryable: true,
      ...details,
    });
  }
}

export class TwoFactorTimeoutError extends EVisaError {
  constructor(message: string, details: EVisaErrorDetails = {}) {
    super(message, {
      code: "TWO_FACTOR_TIMEOUT",
      retryable: true,
      phase: "waiting_for_2fa",
      ...details,
    });
  }
}

export class AuthenticationError extends EVisaError {
  constructor(message: string, details: EVisaErrorDetails = {}) {
    super(message, {
      code: "AUTHENTICATION_FAILED",
      retryable: false,
      ...details,
    });
  }
}

export class SessionExpiredError extends EVisaError {
  constructor(message: string, details: EVisaErrorDetails = {}) {
    super(message, {
      code: "SESSION_EXPIRED",
      retryable: true,
      ...details,
    });
  }
}

export class ServiceUnavailableError extends EVisaError {
  constructor(message: string, details: EVisaErrorDetails = {}) {
    super(message, {
      code: "SERVICE_UNAVAILABLE",
      retryable: true,
      ...details,
    });
  }
}

export class BrowserLaunchError extends EVisaError {
  constructor(message: string, details: EVisaErrorDetails = {}) {
    super(message, {
      code: "BROWSER_LAUNCH_FAILED",
      retryable: false,
      ...details,
    });
  }
}

export class ConfigError extends EVisaError {
  constructor(message: string, details: EVisaErrorDetails = {}) {
    super(message, {
      code: "CONFIG_INVALID",
      retryable: false,
      ...details,
    });
  }
}
