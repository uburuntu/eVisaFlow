import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Locator, Page } from "playwright";
import {
  EVISA_STATUS_ARTIFACT_PREFIX,
  formatArtifactDateSegment,
  parseGovUkDate,
  sanitizeSegment,
  splitName,
} from "./core/artifact-naming.js";
import {
  ensureParentDirectory,
  readDownloadBytes,
  resolveOutputPath,
  saveDownloadPdf,
} from "./core/artifacts.js";
import type { Logger } from "./core/internal-types.js";
import {
  checkFirst,
  clickFirstAndWait,
  fillFirst,
  findFirst,
  readSummaryList,
} from "./core/page-actions.js";
import {
  createPageSnapshot,
  createSanitizedDiagnosticSnapshot,
} from "./core/page-snapshot.js";
import { captureStandaloneHtml } from "./core/standalone-html.js";
import { AuthenticationError, EVisaError } from "./errors/index.js";
import type {
  ArtifactRef,
  DiagnosticsMode,
  EVisaEvent,
  HtmlOutputMode,
  HtmlResult,
  PdfOutputMode,
  PdfResult,
  ShareCodeCheckDetails,
  ShareCodeCheckPurpose,
  VerifiedStatusSummary,
  VerifyShareCodeResult,
} from "./types.js";

const CHECK_STATUS_URL = "https://www.gov.uk/check-immigration-status";

const durationMs = (startedAt: number): number =>
  Math.round((Date.now() - startedAt) * 100) / 100;

const emitTiming = (
  emit: (event: EVisaEvent) => void,
  operation: Extract<EVisaEvent, { type: "timing" }>["operation"],
  phase: Extract<EVisaEvent, { type: "timing" }>["phase"],
  startedAt: number,
  url?: string
): void => {
  emit({
    type: "timing",
    operation,
    phase,
    durationMs: durationMs(startedAt),
    url,
  });
};

export interface ParsedDateOfBirth {
  day: number;
  month: number;
  year: number;
}

export interface ResolvedHtmlArtifact {
  enabled: boolean;
  mode: HtmlOutputMode;
  directory: string;
  path?: string;
  maxBytes: number;
  inlineImages: boolean;
  inlineStyles: boolean;
}

export interface ResolvedPdfArtifact {
  enabled: boolean;
  mode: PdfOutputMode;
  directory: string;
  path?: string;
  maxBytes: number;
}

export interface ResolvedCheckerArtifacts {
  enabled: boolean;
  html: ResolvedHtmlArtifact;
  pdf: ResolvedPdfArtifact;
}

export interface ShareCodeCheckRunOptions {
  page: Page;
  shareCode: string;
  dateOfBirth: ParsedDateOfBirth;
  checkDetails?: ShareCodeCheckDetails;
  artifacts: ResolvedCheckerArtifacts;
  navigationTimeoutMs: number;
  diagnosticsMode?: DiagnosticsMode;
  diagnosticsDir?: string;
  logger: Logger;
  emit: (event: EVisaEvent) => void;
  startUrl?: string;
  preCapturedHtml?: {
    result: HtmlResult;
    artifact?: ArtifactRef;
  };
}

const DEFAULT_CHECK_DETAILS: Required<ShareCodeCheckDetails> = {
  jobTitle: "Traveller",
  organisation: "Self",
  purpose: "travel",
  otherPurpose: "Other",
};

const purposeLabels: Record<Exclude<ShareCodeCheckPurpose, "other">, string> = {
  driving_licence: "A driving licence",
  student_loan: "A student loan",
  education_or_training: "Education or training",
  travel: "Travel",
  health_insurance_card: "A global or european health insurance card",
  personal_finance:
    "Personal finance (including bank and building society accounts, loans, credit cards and mortgages)",
  homelessness_or_council_housing: "Homelessness assistance or council housing",
};

const purposeIds: Record<Exclude<ShareCodeCheckPurpose, "other">, string> = {
  driving_licence: "DRIVING_LICENCE",
  student_loan: "STUDENT_LOAN",
  education_or_training: "EDUCATION_OR_TRAINING",
  travel: "TRAVEL",
  health_insurance_card: "GLOBAL_OR_EUROPEAN_HEALTH_CARD",
  personal_finance: "PERSONAL_FINANCE",
  homelessness_or_council_housing: "HOMELESSNESS_OR_COUNCIL_HOUSING",
};

export const normalizeShareCode = (value: string): string => {
  const normalized = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z0-9]{9}$/.test(normalized)) {
    throw new Error("shareCode must contain exactly 9 letters or digits");
  }
  return normalized;
};

export const formatShareCode = (value: string): string => {
  const normalized = normalizeShareCode(value);
  return `${normalized.slice(0, 3)} ${normalized.slice(3, 6)} ${normalized.slice(6)}`;
};

const mergedCheckDetails = (
  details: ShareCodeCheckDetails | undefined
): Required<ShareCodeCheckDetails> => ({
  ...DEFAULT_CHECK_DETAILS,
  ...details,
});

const clickContinue = async (page: Page, timeout: number): Promise<void> => {
  await clickFirstAndWait(
    page,
    [
      {
        name: "button role named Continue",
        locator: page.getByRole("button", { name: /^Continue$/i }),
      },
      {
        name: "submit button with Continue text",
        locator: page.locator('button[type="submit"]:has-text("Continue")'),
      },
      {
        name: "submit button with Continue aria-label",
        locator: page.locator('button[aria-label="Continue"]'),
      },
      {
        name: "submit input with Continue value",
        locator: page.locator('input[type="submit"][value="Continue"]'),
      },
    ],
    "Continue button",
    timeout
  );
};

const readText = async (locator: Locator): Promise<string | undefined> => {
  const count = await locator.count().catch(() => 0);
  if (count === 0) {
    return undefined;
  }
  const text = await locator
    .first()
    .innerText({ timeout: 1_000 })
    .catch(() => "");
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized || undefined;
};

const readBulletsAfterHeading = async (
  page: Page,
  headingPattern: RegExp
): Promise<string[]> =>
  page.locator("body").evaluate(
    (body, pattern) => {
      const regex = new RegExp(pattern.source, pattern.flags);
      const normalize = (value: string | null | undefined): string =>
        (value ?? "").replace(/\s+/g, " ").trim();
      const headings = Array.from(body.querySelectorAll("h1,h2,h3,h4"));
      const heading = headings.find((candidate) =>
        regex.test(normalize(candidate.textContent))
      );
      if (!heading) {
        return [];
      }

      const values: string[] = [];
      for (
        let element = heading.nextElementSibling;
        element;
        element = element.nextElementSibling
      ) {
        if (/^H[1-4]$/i.test(element.tagName)) {
          break;
        }
        const listItems = element.matches("li")
          ? [element]
          : Array.from(element.querySelectorAll("li"));
        const textItems =
          listItems.length > 0
            ? listItems.map((item) => normalize(item.textContent))
            : element.matches("p")
              ? [normalize(element.textContent)]
              : [];
        for (const text of textItems) {
          if (/^(they|you)?\s*can:?$/i.test(text)) {
            continue;
          }
          if (text) {
            values.push(text);
          }
        }
      }
      return values;
    },
    { source: headingPattern.source, flags: headingPattern.flags }
  );

const readVerifiedStatusSummary = async (page: Page): Promise<VerifiedStatusSummary> => {
  const summary = await readSummaryList(page);
  const cannot = await readBulletsAfterHeading(page, /cannot do/i);
  const canSection = await readBulletsAfterHeading(
    page,
    /(summary of )?what (they|you) can do|things they can do/i
  );
  const allBullets = await page
    .locator("ul.govuk-list--bullet li")
    .evaluateAll((items) =>
      items
        .map((item) => item.textContent?.replace(/\s+/g, " ").trim() ?? "")
        .filter(Boolean)
    );
  const cannotSet = new Set(cannot);
  const can = (canSection.length ? canSection : allBullets).filter(
    (item) => !cannotSet.has(item)
  );

  return {
    name: summary.Name,
    dateOfBirth: summary["Date of birth"],
    nationality: summary.Nationality,
    status: summary.Status,
    validFrom: summary["Valid from"],
    validUntil: summary["Valid until"],
    checkerOrganisation: await readText(page.locator("#checkCompanyName")),
    checkerJobTitle: await readText(page.locator("#checkJobTitle")),
    checkDate: await readText(page.locator("#checkDate")),
    checkReferenceNumber: await readText(page.locator("#checkReferenceNumber")),
    checkPurpose: await readText(page.locator("#checkPurpose")),
    can: can.length ? can : undefined,
    cannot: cannot.length ? cannot : undefined,
  };
};

const defaultArtifactBasename = (
  summary: VerifiedStatusSummary | undefined,
  shareCode: string
): string => {
  const { givenName, surname } = splitName(summary?.name);
  const artifactDate = parseGovUkDate(summary?.checkDate);
  const dateSegment = formatArtifactDateSegment(artifactDate);
  const identitySegment =
    givenName === "UNKNOWN" && surname === "UNKNOWN"
      ? normalizeShareCode(shareCode)
      : `${sanitizeSegment(givenName)} ${sanitizeSegment(surname)}`;
  return `${EVISA_STATUS_ARTIFACT_PREFIX} - ${identitySegment} - Checked ${dateSegment}`;
};

const addArtifact = (
  refs: ArtifactRef[],
  emit: (event: EVisaEvent) => void,
  phase: "checking_status" | "capturing_checker_html" | "downloading_checker_pdf",
  artifact: ArtifactRef
): void => {
  refs.push(artifact);
  emit({ type: "artifact_saved", phase, artifact });
};

const safeDiagnosticLabel = (label: string): string =>
  label.replace(/[^a-zA-Z0-9_-]/g, "_");

const captureCheckerDiagnostic = async (
  page: Page,
  mode: DiagnosticsMode | undefined,
  directory: string | undefined,
  refs: ArtifactRef[],
  emit: (event: EVisaEvent) => void,
  logger: Logger
): Promise<ArtifactRef[]> => {
  if (!mode || mode === "off" || !directory) {
    return [];
  }

  await mkdir(directory, { recursive: true });
  const label = safeDiagnosticLabel("checker-failure");
  const captured: ArtifactRef[] = [];

  if (mode === "sanitized" || mode === "sanitized_on_failure") {
    try {
      const snapshot = await createPageSnapshot(page);
      const path = join(directory, `${label}.snapshot.json`);
      await writeFile(
        path,
        JSON.stringify(createSanitizedDiagnosticSnapshot(snapshot), null, 2),
        "utf-8"
      );
      captured.push({ kind: "snapshot", path, sanitized: true });
    } catch (error) {
      logger.warn("Failed to capture checker diagnostic snapshot", { error });
    }
  }

  if (mode === "raw") {
    try {
      const screenshotPath = join(directory, `${label}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      captured.push({ kind: "screenshot", path: screenshotPath, sanitized: false });
    } catch (error) {
      logger.warn("Failed to capture checker diagnostic screenshot", { error });
    }

    try {
      const htmlPath = join(directory, `${label}.html`);
      await writeFile(htmlPath, await page.content(), "utf-8");
      captured.push({ kind: "html", path: htmlPath, sanitized: false });
    } catch (error) {
      logger.warn("Failed to capture checker diagnostic HTML", { error });
    }
  }

  for (const artifact of captured) {
    addArtifact(refs, emit, "checking_status", artifact);
  }
  return captured;
};

const attachArtifactRefs = (error: unknown, refs: ArtifactRef[]): Error => {
  if (refs.length === 0) {
    return error instanceof Error ? error : new Error(String(error));
  }
  if (error instanceof EVisaError) {
    error.artifactRefs.push(...refs);
    return error;
  }
  return new EVisaError(error instanceof Error ? error.message : String(error), {
    artifactRefs: refs,
    cause: error,
  });
};

const readCheckerError = async (page: Page): Promise<string | undefined> => {
  const locator = page.locator(
    [
      ".govuk-error-summary",
      ".govuk-error-message",
      "[role='alert']",
      "[data-module='govuk-error-summary']",
    ].join(",")
  );
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    const isVisible = await candidate.isVisible().catch(() => false);
    if (!isVisible) {
      continue;
    }
    const isCookieBanner = await candidate
      .evaluate((element) => Boolean(element.closest(".govuk-cookie-banner")))
      .catch(() => false);
    if (isCookieBanner) {
      continue;
    }
    const text = await candidate.innerText().catch(() => "");
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
};

const throwIfCheckerError = async (page: Page): Promise<void> => {
  const errorText = await readCheckerError(page);
  if (!errorText) {
    return;
  }
  throw new AuthenticationError(`Status check failed: ${errorText}`, {
    phase: "checking_status",
  });
};

const captureHtmlArtifact = async (
  page: Page,
  artifact: ResolvedHtmlArtifact,
  filenameBase: string,
  refs: ArtifactRef[],
  emit: (event: EVisaEvent) => void
): Promise<HtmlResult | undefined> => {
  if (!artifact.enabled) {
    return undefined;
  }

  emit({ type: "phase_changed", phase: "capturing_checker_html" });
  const startedAt = Date.now();
  const html = await captureStandaloneHtml(page, {
    inlineImages: artifact.inlineImages,
    inlineStyles: artifact.inlineStyles,
    removeRuntimeChrome: true,
  });
  const bytes = Buffer.from(html, "utf-8");
  if (bytes.byteLength > artifact.maxBytes) {
    throw new Error(
      `Standalone HTML exceeded configured max size of ${artifact.maxBytes} bytes`
    );
  }
  const defaultFilename = `${filenameBase}.html`;

  if (artifact.mode === "bytes") {
    emitTiming(emit, "artifact", "capturing_checker_html", startedAt, page.url());
    return {
      kind: "bytes",
      bytes,
      filename: defaultFilename,
      contentType: "text/html",
      byteLength: bytes.byteLength,
      standalone: true,
    };
  }

  const path = resolveOutputPath(artifact.directory, artifact.path, defaultFilename);
  await ensureParentDirectory(path);
  await writeFile(path, bytes);
  emitTiming(emit, "artifact", "capturing_checker_html", startedAt, page.url());
  addArtifact(refs, emit, "capturing_checker_html", {
    kind: "html",
    path,
    sanitized: false,
  });
  return {
    kind: "file",
    path,
    filename: basename(path),
    contentType: "text/html",
    standalone: true,
  };
};

const downloadPdfArtifact = async (
  page: Page,
  artifact: ResolvedPdfArtifact,
  filenameBase: string,
  refs: ArtifactRef[],
  emit: (event: EVisaEvent) => void,
  timeout: number
): Promise<PdfResult | undefined> => {
  if (!artifact.enabled) {
    return undefined;
  }

  emit({ type: "phase_changed", phase: "downloading_checker_pdf" });
  const startedAt = Date.now();
  const pdfLink = await findFirst(
    [
      {
        name: "Download PDF link",
        locator: page.getByRole("link", { name: /Download PDF/i }),
      },
      {
        name: "download PDF aria-label",
        locator: page.locator('a[aria-label="Download PDF"]'),
      },
      { name: "PDF href", locator: page.locator('a[href*="/pdf"]') },
    ],
    "checker Download PDF link",
    timeout
  );
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout }),
    pdfLink.click({ timeout }),
  ]);
  const defaultFilename = `${filenameBase}.pdf`;

  if (artifact.mode === "bytes") {
    let bytes: Uint8Array;
    try {
      bytes = await readDownloadBytes(download, artifact.maxBytes);
    } finally {
      await download.delete().catch(() => {});
    }
    emitTiming(emit, "artifact", "downloading_checker_pdf", startedAt, page.url());
    return {
      kind: "bytes",
      bytes,
      filename: defaultFilename,
      contentType: "application/pdf",
      byteLength: bytes.byteLength,
    };
  }

  const path = resolveOutputPath(artifact.directory, artifact.path, defaultFilename);
  await ensureParentDirectory(path);
  await saveDownloadPdf(download, path, artifact.maxBytes);
  emitTiming(emit, "artifact", "downloading_checker_pdf", startedAt, page.url());
  addArtifact(refs, emit, "downloading_checker_pdf", {
    kind: "pdf",
    path,
    sanitized: false,
  });
  return {
    kind: "file",
    path,
    filename: basename(path),
    contentType: "application/pdf",
  };
};

const selectPurpose = async (
  page: Page,
  details: Required<ShareCodeCheckDetails>,
  timeout: number
): Promise<void> => {
  if (details.purpose === "other") {
    await checkFirst(
      [
        { name: "other purpose radio", locator: page.locator("#purpose-other") },
        {
          name: "other purpose label",
          locator: page.getByLabel(/another reason/i),
        },
      ],
      "checker purpose radio",
      timeout
    );
    await fillFirst(
      [
        { name: "other purpose input", locator: page.locator("#otherPurpose") },
        {
          name: "other purpose label",
          locator: page.getByLabel(/Enter your reason/i),
        },
      ],
      details.otherPurpose,
      "checker other purpose",
      timeout
    );
    return;
  }

  const label = purposeLabels[details.purpose];
  const id = purposeIds[details.purpose];
  await checkFirst(
    [
      { name: `${id} radio`, locator: page.locator(`#purpose-${id}`) },
      { name: `${label} label`, locator: page.getByLabel(label, { exact: true }) },
    ],
    "checker purpose radio",
    timeout
  );
};

export const runShareCodeCheck = async (
  options: ShareCodeCheckRunOptions
): Promise<VerifyShareCodeResult> => {
  const {
    page,
    dateOfBirth,
    navigationTimeoutMs,
    logger,
    emit,
    artifacts,
    diagnosticsMode,
    diagnosticsDir,
    startUrl = CHECK_STATUS_URL,
  } = options;
  const shareCode = normalizeShareCode(options.shareCode);
  const formattedShareCode = formatShareCode(shareCode);
  const details = mergedCheckDetails(options.checkDetails);
  const artifactRefs: ArtifactRef[] = [];
  const checkerStartedAt = Date.now();

  try {
    emit({ type: "phase_changed", phase: "checking_status" });
    logger.info("Navigating to share-code checker", { startUrl });
    await page.goto(startUrl, { waitUntil: "domcontentloaded" });
    await clickFirstAndWait(
      page,
      [
        {
          name: "Start now link",
          locator: page.getByRole("link", { name: /Start now/i }),
        },
        {
          name: "Start now button link",
          locator: page.locator("a.govuk-button:has-text('Start now')"),
        },
      ],
      "checker Start now link",
      navigationTimeoutMs
    );

    await fillFirst(
      [
        { name: "share code input", locator: page.locator("#shareCode") },
        {
          name: "shareCode named input",
          locator: page.locator('input[name="shareCode"]'),
        },
        { name: "share code label", locator: page.getByLabel(/Share code/i) },
      ],
      shareCode,
      "checker share code",
      navigationTimeoutMs
    );
    await clickContinue(page, navigationTimeoutMs);
    await throwIfCheckerError(page);

    await fillFirst(
      [
        { name: "DOB day input", locator: page.locator("#dob-day") },
        { name: "dob-day named input", locator: page.locator('input[name="dob-day"]') },
      ],
      String(dateOfBirth.day),
      "checker date of birth day",
      navigationTimeoutMs
    );
    await fillFirst(
      [
        { name: "DOB month input", locator: page.locator("#dob-month") },
        {
          name: "dob-month named input",
          locator: page.locator('input[name="dob-month"]'),
        },
      ],
      String(dateOfBirth.month),
      "checker date of birth month",
      navigationTimeoutMs
    );
    await fillFirst(
      [
        { name: "DOB year input", locator: page.locator("#dob-year") },
        { name: "dob-year named input", locator: page.locator('input[name="dob-year"]') },
      ],
      String(dateOfBirth.year),
      "checker date of birth year",
      navigationTimeoutMs
    );
    await clickContinue(page, navigationTimeoutMs);
    await throwIfCheckerError(page);

    await fillFirst(
      [
        { name: "job title input", locator: page.locator("#jobTitle") },
        { name: "jobTitle named input", locator: page.locator('input[name="jobTitle"]') },
        { name: "job title label", locator: page.getByLabel(/Job title/i) },
      ],
      details.jobTitle,
      "checker job title",
      navigationTimeoutMs
    );
    await fillFirst(
      [
        { name: "company name input", locator: page.locator("#companyName") },
        {
          name: "companyName named input",
          locator: page.locator('input[name="companyName"]'),
        },
        {
          name: "company name label",
          locator: page.getByLabel(/Organisation or company name/i),
        },
      ],
      details.organisation,
      "checker organisation",
      navigationTimeoutMs
    );
    await clickContinue(page, navigationTimeoutMs);
    await throwIfCheckerError(page);

    await selectPurpose(page, details, navigationTimeoutMs);
    await clickContinue(page, navigationTimeoutMs);
    await throwIfCheckerError(page);
    await page.getByRole("heading", { name: /Their immigration status/i }).waitFor({
      state: "visible",
      timeout: navigationTimeoutMs,
    });

    const summary = await readVerifiedStatusSummary(page);
    const filenameBase = defaultArtifactBasename(summary, shareCode);
    const result: VerifyShareCodeResult = {
      shareCode: formattedShareCode,
      summary,
    };

    if (artifacts.enabled) {
      if (options.preCapturedHtml) {
        result.html = options.preCapturedHtml.result;
        if (options.preCapturedHtml.artifact) {
          artifactRefs.push(options.preCapturedHtml.artifact);
        }
      } else {
        result.html = await captureHtmlArtifact(
          page,
          artifacts.html,
          filenameBase,
          artifactRefs,
          emit
        );
      }
      result.pdf = await downloadPdfArtifact(
        page,
        artifacts.pdf,
        filenameBase,
        artifactRefs,
        emit,
        navigationTimeoutMs
      );
    }

    if (artifactRefs.length) {
      result.artifacts = artifactRefs;
    }
    emitTiming(emit, "checker", "checking_status", checkerStartedAt, page.url());
    return result;
  } catch (error) {
    const diagnosticRefs = await captureCheckerDiagnostic(
      page,
      diagnosticsMode,
      diagnosticsDir,
      artifactRefs,
      emit,
      logger
    ).catch(() => []);
    throw attachArtifactRefs(error, diagnosticRefs);
  }
};
