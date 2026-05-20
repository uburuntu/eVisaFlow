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
import { ConfigError, EVisaError, FlowCancelledError } from "./errors/index.js";
import {
  normalizeShareCode,
  type ResolvedCheckerArtifacts,
  type ResolvedHtmlArtifact,
  type ResolvedPdfArtifact,
  runShareCodeCheck,
} from "./share-code-checker.js";
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
  HtmlArtifactOptions,
  PdfArtifactOptions,
  Purpose,
  VerifyShareCodeRequest,
  VerifyShareCodeResult,
} from "./types.js";
import { createLogger } from "./utils/logger.js";

const START_URL =
  "https://www.gov.uk/evisa/view-evisa-get-share-code-prove-immigration-status";

const DEFAULT_PURPOSE: Purpose = "immigration_status_other";
const DEFAULT_MAX_PDF_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_HTML_BYTES = 20 * 1024 * 1024;

const durationMs = (startedAt: number): number =>
  Math.round((Date.now() - startedAt) * 100) / 100;

const abortError = (signal: AbortSignal | undefined): FlowCancelledError | undefined => {
  if (!signal?.aborted) {
    return undefined;
  }
  const reason = signal.reason;
  if (reason instanceof FlowCancelledError) {
    return reason;
  }
  if (reason instanceof Error) {
    return new FlowCancelledError(reason.message, { cause: reason });
  }
  return new FlowCancelledError(typeof reason === "string" ? reason : "Flow cancelled");
};

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  const error = abortError(signal);
  if (error) {
    throw error;
  }
};

const combineSignals = (
  first: AbortSignal,
  second: AbortSignal | undefined
): AbortSignal => {
  if (!second) {
    return first;
  }
  if (first.aborted) {
    return first;
  }
  if (second.aborted) {
    return second;
  }
  return AbortSignal.any([first, second]);
};

interface ResolvedOptions extends InternalRunOptions {
  checker: ResolvedCheckerArtifacts;
}

interface ResolveOptionsSettings {
  checkerDefaultEnabled?: boolean;
}

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
    const date = new Date(Date.UTC(value.year, value.month - 1, value.day));
    if (
      !Number.isInteger(value.day) ||
      !Number.isInteger(value.month) ||
      !Number.isInteger(value.year) ||
      value.day < 1 ||
      value.day > 31 ||
      value.month < 1 ||
      value.month > 12 ||
      value.year < 1900 ||
      value.year > 2100 ||
      date.getUTCFullYear() !== value.year ||
      date.getUTCMonth() !== value.month - 1 ||
      date.getUTCDate() !== value.day
    ) {
      throw new ConfigError("dateOfBirth object is not a valid calendar date");
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

const assertPositiveInteger = (value: number, label: string): void => {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${label} must be a positive integer`);
  }
};

const hasFilesystemOutput = (value: object): boolean =>
  "path" in value || "directory" in value;

const resolveHtmlArtifact = (
  value: HtmlArtifactOptions | undefined,
  checkerEnabled: boolean,
  outputDir: string
): ResolvedHtmlArtifact => {
  const enabled = checkerEnabled && value !== false;
  const objectValue = typeof value === "object" ? value : undefined;
  const mode = objectValue?.mode ?? "file";

  if (mode === "bytes" && objectValue && hasFilesystemOutput(objectValue)) {
    throw new ConfigError(
      "artifacts.checker.html.path and artifacts.checker.html.directory are only valid in file mode"
    );
  }

  const maxBytes = objectValue?.maxBytes ?? DEFAULT_MAX_HTML_BYTES;
  assertPositiveInteger(maxBytes, "artifacts.checker.html.maxBytes");

  return {
    enabled,
    mode,
    directory: mode === "file" ? (objectValue?.directory ?? outputDir) : outputDir,
    path: mode === "file" ? objectValue?.path : undefined,
    maxBytes,
    inlineImages: objectValue?.inlineImages ?? true,
    inlineStyles: objectValue?.inlineStyles ?? true,
  };
};

const resolveCheckerPdfArtifact = (
  value: PdfArtifactOptions | undefined,
  checkerEnabled: boolean,
  outputDir: string
): ResolvedPdfArtifact => {
  const enabled = checkerEnabled && value !== false;
  const objectValue = typeof value === "object" ? value : undefined;
  const mode = objectValue?.mode ?? "file";

  if (mode === "bytes" && objectValue && hasFilesystemOutput(objectValue)) {
    throw new ConfigError(
      "artifacts.checker.pdf.path and artifacts.checker.pdf.directory are only valid in file mode"
    );
  }

  const maxBytes =
    objectValue?.mode === "bytes" && objectValue.maxBytes !== undefined
      ? objectValue.maxBytes
      : DEFAULT_MAX_PDF_BYTES;
  assertPositiveInteger(maxBytes, "artifacts.checker.pdf.maxBytes");

  return {
    enabled,
    mode,
    directory: mode === "file" ? (objectValue?.directory ?? outputDir) : outputDir,
    path: mode === "file" ? objectValue?.path : undefined,
    maxBytes,
  };
};

const resolveCheckerArtifacts = (
  options: EVisaClientOptions,
  outputDir: string,
  defaultEnabled: boolean
): ResolvedCheckerArtifacts => {
  const checker = options.artifacts?.checker;
  const checkerEnabled =
    checker === undefined
      ? defaultEnabled
      : typeof checker === "boolean"
        ? checker
        : true;
  const checkerObject = typeof checker === "object" ? checker : undefined;

  return {
    enabled: checkerEnabled,
    html: resolveHtmlArtifact(checkerObject?.html, checkerEnabled, outputDir),
    pdf: resolveCheckerPdfArtifact(checkerObject?.pdf, checkerEnabled, outputDir),
  };
};

const resolveOptions = (
  options: EVisaClientOptions,
  settings: ResolveOptionsSettings = {}
): ResolvedOptions => {
  const pdf = options.artifacts?.pdf;
  const pdfEnabled = pdf !== false;
  const pdfObject = typeof pdf === "object" ? pdf : undefined;
  if (pdfObject?.mode === "bytes" && hasFilesystemOutput(pdfObject)) {
    throw new ConfigError(
      "artifacts.pdf.path and artifacts.pdf.directory are only valid in file mode"
    );
  }
  const pdfMaxBytes =
    pdfObject?.mode === "bytes" && pdfObject.maxBytes !== undefined
      ? pdfObject.maxBytes
      : DEFAULT_MAX_PDF_BYTES;
  assertPositiveInteger(pdfMaxBytes, "artifacts.pdf.maxBytes");
  const outputDir = pdfObject?.directory ?? "downloads";
  const diagnostics = options.artifacts?.diagnostics;

  return {
    headless: options.browser?.headless ?? true,
    verbose: options.verbose ?? false,
    pdfEnabled,
    pdfOutput: pdfObject?.mode ?? "file",
    pdfMaxBytes,
    outputDir,
    outputFile: pdfObject?.path ?? "",
    userDataDir: options.browser?.userDataDir ?? "",
    diagnosticsMode: diagnostics?.mode ?? "off",
    diagnosticsDir: diagnostics?.directory ?? join(outputDir, "debug"),
    navigationTimeoutMs: options.timeouts?.navigationMs ?? 60_000,
    actionTimeoutMs: options.timeouts?.actionMs ?? 30_000,
    twoFactorTimeoutMs: options.timeouts?.twoFactorMs ?? 10 * 60_000,
    checker: resolveCheckerArtifacts(
      options,
      outputDir,
      settings.checkerDefaultEnabled ?? false
    ),
  };
};

const requireValidShareCode = (value: string): void => {
  try {
    normalizeShareCode(value);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }
};

const formatDate = (value: Date | undefined): string | undefined => {
  if (!value || Number.isNaN(value.getTime())) {
    return undefined;
  }
  return value.toISOString().slice(0, 10);
};

const closeBrowserSession = async (
  logger: ReturnType<typeof createLogger>,
  context: BrowserContext | undefined,
  browser: Browser | null | undefined
): Promise<void> => {
  try {
    await context?.close();
  } catch (error) {
    logger.warn("Failed to close browser context", { error });
  }

  try {
    await browser?.close();
  } catch (error) {
    logger.warn("Failed to close browser", { error });
  }
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
    const closeOnAbort = () => {
      void context?.close().catch(() => {});
      void browser?.close().catch(() => {});
    };
    request.signal?.addEventListener("abort", closeOnAbort, { once: true });

    try {
      throwIfAborted(request.signal);
      const launchStartedAt = Date.now();
      const handle = await launchBrowser(options);
      this.emit({
        type: "timing",
        phase: "launching",
        operation: "browser_launch",
        durationMs: durationMs(launchStartedAt),
      });
      browser = handle.browser;
      context = handle.context;
      throwIfAborted(request.signal);
      const page = handle.page;
      const runner = new StepRunner({
        steps: defaultSteps(),
        context: {
          credentials,
          purpose: request.purpose ?? DEFAULT_PURPOSE,
          options,
          logger,
          page,
          signal: request.signal,
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
            const response = await request.onChallenge(challenge, {
              ...challengeContext,
              signal: combineSignals(challengeContext.signal, request.signal),
            });
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

      if (options.checker.enabled) {
        const checkerResult = await runShareCodeCheck({
          page,
          shareCode: internalResult.shareCode,
          dateOfBirth: credentials.dateOfBirth,
          checkDetails: request.checkDetails,
          artifacts: options.checker,
          navigationTimeoutMs: options.navigationTimeoutMs,
          diagnosticsMode: options.diagnosticsMode,
          diagnosticsDir: options.diagnosticsDir,
          logger,
          emit: this.emit,
        });
        result.checker = checkerResult;
        if (checkerResult.artifacts?.length) {
          result.artifacts = [...(result.artifacts ?? []), ...checkerResult.artifacts];
        }
      }

      this.emit({ type: "completed", phase: "completed", result });
      return result;
    } catch (error) {
      const finalError = abortError(request.signal) ?? error;
      logger.error("Flow failed", { error: finalError });
      this.emit({
        type: "failed",
        phase: "failed",
        error: {
          name: finalError instanceof Error ? finalError.name : "Error",
          message: finalError instanceof Error ? finalError.message : String(finalError),
          code: finalError instanceof EVisaError ? finalError.code : undefined,
          retryable: finalError instanceof EVisaError ? finalError.retryable : undefined,
        },
      });
      throw finalError;
    } finally {
      request.signal?.removeEventListener("abort", closeOnAbort);
      await closeBrowserSession(logger, context, browser);
    }
  }

  async verifyShareCode(request: VerifyShareCodeRequest): Promise<VerifyShareCodeResult> {
    const options = resolveOptions(this.options, { checkerDefaultEnabled: true });
    const dateOfBirth = parseDateOfBirth(request.dateOfBirth);
    requireValidShareCode(request.shareCode);
    const logger = createLogger({ verbose: options.verbose });
    this.emit({ type: "run_started", phase: "launching" });

    let browser: Browser | null | undefined;
    let context: BrowserContext | undefined;
    const closeOnAbort = () => {
      void context?.close().catch(() => {});
      void browser?.close().catch(() => {});
    };
    request.signal?.addEventListener("abort", closeOnAbort, { once: true });

    try {
      throwIfAborted(request.signal);
      const launchStartedAt = Date.now();
      const handle = await launchBrowser(options);
      this.emit({
        type: "timing",
        phase: "launching",
        operation: "browser_launch",
        durationMs: durationMs(launchStartedAt),
      });
      browser = handle.browser;
      context = handle.context;
      throwIfAborted(request.signal);
      const result = await runShareCodeCheck({
        page: handle.page,
        shareCode: request.shareCode,
        dateOfBirth,
        checkDetails: request.checkDetails,
        artifacts: options.checker,
        navigationTimeoutMs: options.navigationTimeoutMs,
        diagnosticsMode: options.diagnosticsMode,
        diagnosticsDir: options.diagnosticsDir,
        logger,
        emit: this.emit,
      });

      this.emit({ type: "completed", phase: "completed", result });
      return result;
    } catch (error) {
      const finalError = abortError(request.signal) ?? error;
      logger.error("Share-code checker failed", { error: finalError });
      this.emit({
        type: "failed",
        phase: "failed",
        error: {
          name: finalError instanceof Error ? finalError.name : "Error",
          message: finalError instanceof Error ? finalError.message : String(finalError),
          code: finalError instanceof EVisaError ? finalError.code : undefined,
          retryable: finalError instanceof EVisaError ? finalError.retryable : undefined,
        },
      });
      throw finalError;
    } finally {
      request.signal?.removeEventListener("abort", closeOnAbort);
      await closeBrowserSession(logger, context, browser);
    }
  }
}
