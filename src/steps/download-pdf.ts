import { BaseStep } from "./base-step.js";
import { HEADINGS, SELECTORS } from "../utils/selectors.js";
import type { StepContext } from "../types.js";
import { join, isAbsolute } from "node:path";

const shareCodeRegex =
  /Share code\s*([A-Z0-9]{3}\s+[A-Z0-9]{3}\s+[A-Z0-9]{3})/i;
const validUntilRegex = /valid until\s+([0-9]{1,2}\s+\w+\s+\d{4})/i;
const nameRegex = /Name\s+([A-Z][A-Z\s'-]+)\s+Date of birth/i;

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

export class DownloadPdfStep extends BaseStep {
  id = "download-pdf";

  async detect(page: import("playwright").Page): Promise<boolean> {
    return this.hasHeading(page, HEADINGS.details);
  }

  async execute(context: StepContext): Promise<void> {
    const { page, logger, options } = context;
    logger.action("download", "pdf");

    const bodyText = await page.locator("body").innerText();
    const shareMatch = bodyText.match(shareCodeRegex);
    const validUntilMatch = bodyText.match(validUntilRegex);

    const shareCode = shareMatch?.[1]?.replace(/\s+/g, " ").trim() ?? "";
    const validUntil = validUntilMatch?.[1]
      ? new Date(validUntilMatch[1])
      : undefined;

    const nameFromTable = await page
      .locator('dt:has-text("Name")')
      .first()
      .locator("xpath=following-sibling::dd[1]")
      .textContent()
      .then((value) => value?.trim() ?? "")
      .catch(() => "");
    const nameFromText = bodyText.match(nameRegex)?.[1]?.trim() ?? "";
    const rawName = nameFromTable || nameFromText;
    const nameParts = rawName.split(/\s+/).filter(Boolean);
    const givenName = nameParts[0] ?? "UNKNOWN";
    const surname = nameParts[nameParts.length - 1] ?? "UNKNOWN";
    const expirySegment = formatDate(validUntil);
    const defaultFilename = `EVISA_${sanitizeSegment(surname)}_${sanitizeSegment(
      givenName
    )}_${expirySegment}.pdf`;

    const downloadPromise = page.waitForEvent("download");
    await page.locator(SELECTORS.downloadPdfLink).click();
    const download = await downloadPromise;

    const filename = options.outputFile
      ? isAbsolute(options.outputFile)
        ? options.outputFile
        : join(options.outputDir, options.outputFile)
      : join(options.outputDir, defaultFilename);
    await download.saveAs(filename);

    context.setResult({ pdfPath: filename, shareCode, validUntil });
  }
}
