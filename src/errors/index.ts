export class EVisaFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class PageDetectionError extends EVisaFlowError {}
export class SelectorNotFoundError extends EVisaFlowError {}
export class TwoFactorTimeoutError extends EVisaFlowError {}
export class AuthenticationError extends EVisaFlowError {}
export class SessionExpiredError extends EVisaFlowError {}
