import { basename } from "node:path";
import {
  EVISA_ARTIFACT_PREFIX,
  formatArtifactDateSegment,
  parseGovUkDate,
  sanitizeSegment,
  splitName,
} from "../core/artifact-naming.js";
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

export class DownloadPdfStep extends BaseStep {
  id = "download-pdf";

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
    const expirySegment = formatArtifactDateSegment(validUntil);
    const defaultFilename = `${EVISA_ARTIFACT_PREFIX}_${sanitizeSegment(
      surname
    )}_${sanitizeSegment(givenName)}_${expirySegment}.pdf`;

    const summary = {
      name: context.extractedData.name,
      nationality: context.extractedData.nationality,
      status: context.extractedData.status,
    };
    const baseResult = {
      shareCode,
      validUntil,
      summary,
      checkerHtml: context.extractedData.checkerHtml,
      checkerHtmlArtifact: context.extractedData.checkerHtmlArtifact,
    };

    if (!options.pdfEnabled) {
      context.setResult(baseResult);
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
        ...baseResult,
        pdfBytes,
        pdfFilename: defaultFilename,
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
      ...baseResult,
      pdfPath: filename,
      pdfFilename: basename(filename),
    });
  }
}
