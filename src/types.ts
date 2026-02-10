export type TwoFactorMethod = "sms" | "email";

export type AuthMethod =
  | { type: "passport"; passportNumber: string }
  | { type: "nationalId"; idNumber: string }
  | { type: "brc"; cardNumber: string }
  | { type: "ukvi"; customerNumber: string };

export type Purpose =
  | "right_to_work"
  | "right_to_rent"
  | "immigration_status_other";

export interface Credentials {
  auth: AuthMethod;
  dateOfBirth: { day: number; month: number; year: number };
  preferredTwoFactorMethod?: TwoFactorMethod;
}

export interface RunOptions {
  headless?: boolean;
  verbose?: boolean;
  screenshotOnError?: boolean;
  outputDir?: string;
  outputFile?: string;
  userDataDir?: string;
  navigationTimeoutMs?: number;
  actionTimeoutMs?: number;
  twoFactorTimeoutMs?: number;
}

export interface EVisaFlowConfig {
  credentials: Credentials;
  purpose?: Purpose;
  onTwoFactorRequired: (
    method: TwoFactorMethod,
    context: { deadlineMs: number }
  ) => Promise<string>;
  options?: RunOptions;
}

export interface RunResult {
  pdfPath: string;
  shareCode: string;
  validUntil?: Date;
}

export interface ExtractedData {
  name?: string;
  validUntil?: string;
}

export interface StepContext {
  credentials: Credentials;
  purpose: Purpose;
  options: Required<RunOptions>;
  logger: Logger;
  page: import("playwright").Page;
  extractedData: ExtractedData;
  setResult: (result: RunResult) => void;
  onTwoFactorRequired: (
    method: TwoFactorMethod,
    context: { deadlineMs: number }
  ) => Promise<string>;
}

export interface Step {
  id: string;
  detect(page: import("playwright").Page): Promise<boolean>;
  execute(context: StepContext): Promise<void>;
}

export interface Logger {
  step(stepId: string, message: string): void;
  action(action: string, detail?: string): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  screenshot(label: string): void;
}
