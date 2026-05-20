import { basename } from "node:path";
import {
  ensureParentDirectory,
  readDownloadBytes,
  resolveOutputPath,
  saveDownloadPdf,
} from "../core/artifacts.js";
import type { StepContext } from "../core/internal-types.js";
import { SelectorNotFoundError } from "../errors/index.js";
import { BaseStep } from "./base-step.js";

const shareCodeRegex = /\b([A-Z0-9]{3}\s+[A-Z0-9]{3}\s+[A-Z0-9]{3})\b/i;
const validUntilRegex =
  /valid until\s+(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i;

const MONTHS = new Map(
  [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].map((month, index) => [month, index])
);

export const sanitizeSegment = (value: string | undefined): string => {
  const input = (value ?? "").trim();
  if (!input) return "UNKNOWN";
  return input
    .normalize("NFKD")
    .replace(/[^\p{ASCII}]/gu, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
};

export const splitName = (
  rawName: string | undefined
): { givenName: string; surname: string } => {
  const name = (rawName ?? "").trim();
  if (!name) {
    return { givenName: "UNKNOWN", surname: "UNKNOWN" };
  }

  if (name.includes(",")) {
    const [surname, givenNames] = name.split(",", 2).map((part) => part.trim());
    return {
      givenName: givenNames?.split(/\s+/).filter(Boolean)[0] ?? "UNKNOWN",
      surname: surname || "UNKNOWN",
    };
  }

  const parts = name.split(/\s+/).filter(Boolean);
  const surname = parts.length > 1 ? parts.at(-1) : parts[0];
  return {
    givenName: parts[0] ?? "UNKNOWN",
    surname: surname ?? "UNKNOWN",
  };
};

export const parseGovUkDate = (value: string | undefined): Date | undefined => {
  const match = value
    ?.trim()
    .match(
      /^(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/i
    );
  if (!match) {
    return undefined;
  }

  const day = Number(match[1]);
  const monthName = match[2]?.toLowerCase();
  const month = monthName ? MONTHS.get(monthName) : undefined;
  const year = Number(match[3]);
  if (month === undefined || !Number.isInteger(day) || !Number.isInteger(year)) {
    return undefined;
  }

  const date = new Date(Date.UTC(year, month, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date;
};

const formatDate = (date: Date | undefined): string => {
  if (!date || Number.isNaN(date.getTime())) return "UNKNOWN";
  return date.toISOString().slice(0, 10);
};

export class DownloadPdfStep extends BaseStep {
  id = "download-pdf";

  async detect(page: import("playwright").Page): Promise<boolean> {
    const hasDownloadLink =
      (await page.getByRole("link", { name: /Download PDF/i }).count()) > 0 ||
      (await page.locator('a[href$="/pdf"]').count()) > 0;

    if (!hasDownloadLink) {
      return false;
    }

    return (
      (await this.hasHeading(page, /Details you need to share/i)) ||
      (await this.hasVisible(page.locator(".gov-uk-share-code"))) ||
      (await this.hasText(page, /Share code/i))
    );
  }

  async execute(context: StepContext): Promise<void> {
    const { page, logger, options } = context;
    logger.action("download", "pdf");

    const bodyText = await this.pageText(page);

    const shareCodeText = await page
      .locator(".gov-uk-share-code, [class*='share-code']")
      .first()
      .innerText()
      .catch(() => "");
    const shareMatch = (shareCodeText || bodyText).match(shareCodeRegex);
    const shareCode = shareMatch?.[1]?.replace(/\s+/g, " ").trim().toUpperCase();
    if (!shareCode) {
      throw new SelectorNotFoundError(
        "Share code not found on the page. Expected format: 3 groups of 3 alphanumeric characters."
      );
    }

    const validUntilMatch = bodyText.match(validUntilRegex);
    const validUntil =
      parseGovUkDate(validUntilMatch?.[1]) ??
      parseGovUkDate(context.extractedData.validUntilText);
    if (!validUntil) {
      logger.warn("Failed to parse valid-until date");
    }

    const rawName = context.extractedData.name ?? "";
    if (!rawName) {
      logger.warn("Name not available; it was not extracted from summary page");
    }
    const { givenName, surname } = splitName(rawName);
    const expirySegment = formatDate(validUntil);
    const defaultFilename = `EVISA_${sanitizeSegment(surname)}_${sanitizeSegment(
      givenName
    )}_${expirySegment}.pdf`;

    const summary = {
      name: context.extractedData.name,
      nationality: context.extractedData.nationality,
      status: context.extractedData.status,
    };

    if (!options.pdfEnabled) {
      context.setResult({ shareCode, validUntil, summary });
      return;
    }

    const downloadLink = await this.findFirst(
      [
        {
          name: "Download PDF link",
          locator: page.getByRole("link", { name: /Download PDF/i }),
        },
        {
          name: "download PDF aria-label",
          locator: page.locator('a[aria-label="Download PDF"]'),
        },
        { name: "PDF href", locator: page.locator('a[href$="/pdf"]') },
      ],
      "Download PDF link"
    );
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: options.actionTimeoutMs }),
      downloadLink.click({ timeout: options.actionTimeoutMs }),
    ]);

    if (options.pdfOutput === "bytes") {
      let pdfBytes: Uint8Array;
      try {
        pdfBytes = await readDownloadBytes(download, options.pdfMaxBytes);
      } finally {
        await download.delete().catch(() => {});
      }
      context.setResult({
        pdfBytes,
        pdfFilename: defaultFilename,
        shareCode,
        validUntil,
        summary,
      });
      return;
    }

    const filename = resolveOutputPath(
      options.outputDir,
      options.outputFile,
      defaultFilename
    );
    await ensureParentDirectory(filename);
    await saveDownloadPdf(download, filename, options.pdfMaxBytes);
    context.addArtifacts([{ kind: "pdf", path: filename, sanitized: false }]);

    context.setResult({
      pdfPath: filename,
      pdfFilename: basename(filename),
      shareCode,
      validUntil,
      summary,
    });
  }
}
