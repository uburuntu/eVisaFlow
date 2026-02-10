import { BaseStep } from "./base-step.js";
import { HEADINGS, SELECTORS } from "../utils/selectors.js";
import type { StepContext } from "../types.js";
import { join, isAbsolute, resolve } from "node:path";
import { SelectorNotFoundError } from "../errors/index.js";

const shareCodeRegex =
  /Share code\s*([A-Z0-9]{3}\s+[A-Z0-9]{3}\s+[A-Z0-9]{3})/;
const validUntilRegex =
  /valid until\s+(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i;

const sanitizeSegment = (value: string | undefined): string => {
  const input = (value ?? "").trim();
  if (!input) return "UNKNOWN";
  return input
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
};

const formatDate = (date: Date | undefined): string => {
  if (!date || Number.isNaN(date.getTime())) return "UNKNOWN";
  return date.toISOString().slice(0, 10);
};

const resolveOutputPath = (outputDir: string, outputFile: string, defaultFilename: string): string => {
  const resolvedDir = resolve(outputDir);
  const filename = outputFile
    ? isAbsolute(outputFile)
      ? outputFile
      : join(resolvedDir, outputFile)
    : join(resolvedDir, defaultFilename);

  const resolvedFilename = resolve(filename);
  if (!resolvedFilename.startsWith(resolvedDir)) {
    throw new Error(
      `Output path "${outputFile}" resolves outside output directory "${outputDir}"`
    );
  }
  return resolvedFilename;
};

export class DownloadPdfStep extends BaseStep {
  id = "download-pdf";

  async detect(page: import("playwright").Page): Promise<boolean> {
    return this.hasHeading(page, HEADINGS.details);
  }

  async execute(context: StepContext): Promise<void> {
    const { page, logger, options } = context;
    logger.action("download", "pdf");

    const bodyText = await page.locator("body").innerText();

    // Extract and validate share code from the download page
    const shareMatch = bodyText.match(shareCodeRegex);
    const shareCode = shareMatch?.[1]?.replace(/\s+/g, " ").trim();
    if (!shareCode) {
      throw new SelectorNotFoundError(
        "Share code not found on the page. Expected format: 3 groups of 3 alphanumeric characters."
      );
    }

    // Valid-until: prefer data extracted from summary page, fall back to download page text
    let validUntil: Date | undefined;
    if (context.extractedData.validUntil) {
      validUntil = new Date(context.extractedData.validUntil);
    } else {
      const validUntilMatch = bodyText.match(validUntilRegex);
      if (validUntilMatch?.[1]) {
        validUntil = new Date(validUntilMatch[1]);
      }
    }
    if (validUntil && Number.isNaN(validUntil.getTime())) {
      logger.warn("Failed to parse valid-until date");
      validUntil = undefined;
    }

    // Name: use data extracted from summary page (name is not on this page)
    const rawName = context.extractedData.name ?? "";
    if (!rawName) {
      logger.warn("Name not available — was not extracted from summary page");
    }
    const nameParts = rawName.split(/\s+/).filter(Boolean);
    const givenName = nameParts[0] ?? "UNKNOWN";
    const surname = nameParts.length > 1
      ? nameParts[nameParts.length - 1]!
      : givenName;
    const expirySegment = formatDate(validUntil);
    const defaultFilename = `EVISA_${sanitizeSegment(surname)}_${sanitizeSegment(
      givenName
    )}_${expirySegment}.pdf`;

    const filename = resolveOutputPath(
      options.outputDir,
      options.outputFile,
      defaultFilename
    );

    const downloadPromise = page.waitForEvent("download");
    await page.locator(SELECTORS.downloadPdfLink).click();
    const download = await downloadPromise;
    await download.saveAs(filename);

    context.setResult({ pdfPath: filename, shareCode, validUntil });
  }
}
