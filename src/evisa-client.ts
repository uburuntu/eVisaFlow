import { basename, join } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import { launchBrowser } from "./core/browser.js";
import type {
  InternalAuthMethod,
  InternalCredentials,
  InternalRunOptions,
  Step,
} from "./core/internal-types.js";
import { emitSafe, StepRunner } from "./core/step-runner.js";
import { ConfigError, EVisaError } from "./errors/index.js";
import { ConfirmationStep } from "./steps/confirmation.js";
import { DateOfBirthStep } from "./steps/date-of-birth.js";
import { DocumentNumberStep } from "./steps/document-number.js";
import { DocumentTypeStep } from "./steps/document-type.js";
import { DownloadPdfStep } from "./steps/download-pdf.js";
import { EntryPageStep } from "./steps/entry-page.js";
import { ProveStatusStep } from "./steps/prove-status.js";
import { PurposeSelectionStep } from "./steps/purpose-selection.js";
import { SummaryStep } from "./steps/summary.js";
import { TwoFactorCodeStep } from "./steps/two-factor-code.js";
import { TwoFactorMethodStep } from "./steps/two-factor-method.js";
import type {
  Applicant,
  CreateShareCodeRequest,
  CreateShareCodeResult,
  EVisaChallenge,
  EVisaClientOptions,
  EVisaEvent,
  Purpose,
} from "./types.js";
import { createLogger } from "./utils/logger.js";

const START_URL =
  "https://www.gov.uk/evisa/view-evisa-get-share-code-prove-immigration-status";

const DEFAULT_PURPOSE: Purpose = "immigration_status_other";

const defaultSteps = (): Step[] => [
  new EntryPageStep(),
  new DocumentTypeStep(),
  new DocumentNumberStep(),
  new DateOfBirthStep(),
  new TwoFactorMethodStep(),
  new TwoFactorCodeStep(),
  new ProveStatusStep(),
  new PurposeSelectionStep(),
  new ConfirmationStep(),
  new SummaryStep(),
  new DownloadPdfStep(),
];

const parseDateOfBirth = (
  value: Applicant["dateOfBirth"]
): InternalCredentials["dateOfBirth"] => {
  if (typeof value !== "string") {
    if (
      !Number.isInteger(value.day) ||
      !Number.isInteger(value.month) ||
      !Number.isInteger(value.year) ||
      value.day < 1 ||
      value.day > 31 ||
      value.month < 1 ||
      value.month > 12 ||
      value.year < 1900 ||
      value.year > 2100
    ) {
      throw new ConfigError("dateOfBirth object is outside the supported range");
    }
    return value;
  }

  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new ConfigError("dateOfBirth must be an ISO date string: YYYY-MM-DD");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new ConfigError("dateOfBirth is not a valid calendar date");
  }

  return { day, month, year };
};

const toInternalAuth = (applicant: Applicant): InternalAuthMethod => {
  const { identityDocument } = applicant;
  const number = identityDocument.number.trim();
  if (number.length < 3) {
    throw new ConfigError("identityDocument.number must contain at least 3 characters");
  }

  switch (identityDocument.type) {
    case "passport":
      return { type: "passport", passportNumber: number };
    case "nationalId":
      return { type: "nationalId", idNumber: number };
    case "brc":
      return { type: "brc", cardNumber: number };
    case "ukvi":
      return { type: "ukvi", customerNumber: number };
  }
};

const toInternalCredentials = (request: CreateShareCodeRequest): InternalCredentials => ({
  auth: toInternalAuth(request.applicant),
  dateOfBirth: parseDateOfBirth(request.applicant.dateOfBirth),
  preferredTwoFactorMethod: request.challengePreference?.deliveryMethod,
});

const resolveOptions = (options: EVisaClientOptions): InternalRunOptions => {
  const pdf = options.artifacts?.pdf;
  const pdfEnabled = pdf !== false;
  const pdfObject = typeof pdf === "object" ? pdf : undefined;
  const outputDir = pdfObject?.directory ?? "downloads";
  const diagnostics = options.artifacts?.diagnostics;

  return {
    headless: options.browser?.headless ?? true,
    verbose: options.verbose ?? false,
    pdfEnabled,
    pdfOutput: pdfObject?.mode ?? "file",
    outputDir,
    outputFile: pdfObject?.path ?? "",
    userDataDir: options.browser?.userDataDir ?? "",
    diagnosticsMode: diagnostics?.mode ?? "off",
    diagnosticsDir: diagnostics?.directory ?? join(outputDir, "debug"),
    navigationTimeoutMs: options.timeouts?.navigationMs ?? 60_000,
    actionTimeoutMs: options.timeouts?.actionMs ?? 30_000,
    twoFactorTimeoutMs: options.timeouts?.twoFactorMs ?? 10 * 60_000,
  };
};

const formatDate = (value: Date | undefined): string | undefined => {
  if (!value || Number.isNaN(value.getTime())) {
    return undefined;
  }
  return value.toISOString().slice(0, 10);
};

export class EVisaClient {
  private readonly options: EVisaClientOptions;
  private readonly emit: (event: EVisaEvent) => void;

  constructor(options: EVisaClientOptions = {}) {
    this.options = options;
    this.emit = emitSafe(options.onEvent);
  }

  async createShareCode(request: CreateShareCodeRequest): Promise<CreateShareCodeResult> {
    const options = resolveOptions(this.options);
    const credentials = toInternalCredentials(request);
    const logger = createLogger({ verbose: options.verbose });
    this.emit({ type: "run_started", phase: "launching" });

    let browser: Browser | null | undefined;
    let context: BrowserContext | undefined;

    try {
      const handle = await launchBrowser(options);
      browser = handle.browser;
      context = handle.context;
      const page = handle.page;
      const runner = new StepRunner({
        steps: defaultSteps(),
        context: {
          credentials,
          purpose: request.purpose ?? DEFAULT_PURPOSE,
          options,
          logger,
          page,
          extractedData: {},
          emit: this.emit,
          onTwoFactorRequired: async (method, challengeContext) => {
            const challenge: EVisaChallenge = {
              type: "security_code",
              deliveryMethod: method,
              deadlineMs: challengeContext.deadlineMs,
            };
            this.emit({
              type: "challenge_required",
              phase: "waiting_for_2fa",
              challenge,
            });
            const response = await request.onChallenge(challenge, challengeContext);
            return response.code;
          },
        },
      });
      const internalResult = await runner.run(START_URL);
      const result: CreateShareCodeResult = {
        shareCode: internalResult.shareCode,
        validUntil: formatDate(internalResult.validUntil),
        summary: internalResult.summary,
        artifacts: internalResult.artifacts?.length
          ? internalResult.artifacts
          : undefined,
      };

      if (internalResult.pdfBytes) {
        result.pdf = {
          kind: "bytes",
          bytes: internalResult.pdfBytes,
          filename: internalResult.pdfFilename ?? "evisa.pdf",
          contentType: "application/pdf",
          byteLength: internalResult.pdfBytes.byteLength,
        };
      } else if (internalResult.pdfPath) {
        result.pdf = {
          kind: "file",
          path: internalResult.pdfPath,
          filename: internalResult.pdfFilename ?? basename(internalResult.pdfPath),
          contentType: "application/pdf",
        };
      }

      this.emit({ type: "completed", phase: "completed", result });
      return result;
    } catch (error) {
      logger.error("Flow failed", { error });
      this.emit({
        type: "failed",
        phase: "failed",
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
          code: error instanceof EVisaError ? error.code : undefined,
          retryable: error instanceof EVisaError ? error.retryable : undefined,
        },
      });
      throw error;
    } finally {
      await context?.close();
      if (browser) {
        await browser.close();
      }
    }
  }
}
