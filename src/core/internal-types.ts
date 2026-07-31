import type { Page } from "playwright";
import type {
  ArtifactRef,
  DiagnosticsMode,
  EVisaEvent,
  HtmlResult,
  PdfOutputMode,
  Purpose,
  TwoFactorMethod,
} from "../types.js";
import type { PageClassification } from "./page-classifier.js";

export type { TwoFactorMethod } from "../types.js";

export type InternalAuthMethod =
  | { type: "passport"; passportNumber: string }
  | { type: "nationalId"; idNumber: string }
  | { type: "brc"; cardNumber: string }
  | { type: "ukvi"; customerNumber: string };

export type AuthMethod = InternalAuthMethod;

export interface InternalCredentials {
  auth: InternalAuthMethod;
  dateOfBirth: { day: number; month: number; year: number };
  preferredTwoFactorMethod?: TwoFactorMethod;
}

export interface InternalRunOptions {
  headless: boolean;
  verbose: boolean;
  pdfEnabled: boolean;
  pdfOutput: PdfOutputMode;
  pdfMaxBytes: number;
  outputDir: string;
  outputFile: string;
  userDataDir: string;
  diagnosticsMode: DiagnosticsMode;
  diagnosticsDir: string;
  navigationTimeoutMs: number;
  actionTimeoutMs: number;
  twoFactorTimeoutMs: number;
}

export type RunOptions = InternalRunOptions;

export interface InternalRunResult {
  shareCode: string;
  validUntil?: Date;
  pdfPath?: string;
  pdfBytes?: Uint8Array;
  pdfFilename?: string;
  checkerHtml?: HtmlResult;
  checkerHtmlArtifact?: ArtifactRef;
  summary?: {
    name?: string;
    nationality?: string;
    status?: string;
  };
  artifacts?: ArtifactRef[];
}

export type RunResult = InternalRunResult;

export interface ExtractedData {
  name?: string;
  dateOfBirth?: string;
  nationality?: string;
  status?: string;
  validFrom?: string;
  validUntilText?: string;
  summary?: Record<string, string>;
  checkerHtml?: HtmlResult;
  checkerHtmlArtifact?: ArtifactRef;
}

export interface StepContext {
  credentials: InternalCredentials;
  purpose: Purpose;
  options: InternalRunOptions;
  logger: Logger;
  page: Page;
  signal?: AbortSignal;
  extractedData: ExtractedData;
  classification?: PageClassification;
  setResult: (result: InternalRunResult) => void;
  addArtifacts: (artifacts: ArtifactRef[]) => void;
  emit: (event: EVisaEvent) => void;
  onTwoFactorRequired: (
    method: TwoFactorMethod,
    context: { deadlineMs: number; signal: AbortSignal }
  ) => Promise<string>;
}

export interface Step {
  id: string;
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
