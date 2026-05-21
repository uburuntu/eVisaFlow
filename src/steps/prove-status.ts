import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { ensureParentDirectory, resolveOutputPath } from "../core/artifacts.js";
import type { StepContext } from "../core/internal-types.js";
import { captureStandaloneHtml } from "../core/standalone-html.js";
import type { ArtifactRef, EVisaPhase, HtmlOutputMode } from "../types.js";
import { BaseStep } from "./base-step.js";
import { parseGovUkDate, sanitizeSegment, splitName } from "./download-pdf.js";

interface CheckerHtmlArtifact {
  enabled: boolean;
  mode: HtmlOutputMode;
  directory: string;
  path?: string;
  maxBytes: number;
  inlineImages: boolean;
  inlineStyles: boolean;
}

type OptionsWithCheckerHtml = StepContext["options"] & {
  checker?: {
    enabled: boolean;
    html: CheckerHtmlArtifact;
  };
};

const formatDateSegment = (value: string | undefined): string => {
  const date = parseGovUkDate(value);
  if (!date || Number.isNaN(date.getTime())) {
    return "UNKNOWN";
  }
  return date.toISOString().slice(0, 10);
};

const statusHtmlBasename = (summary: Record<string, string>): string => {
  const { givenName, surname } = splitName(summary.Name);
  return `EVISA_STATUS_${sanitizeSegment(surname)}_${sanitizeSegment(
    givenName
  )}_${formatDateSegment(summary["Valid until"])}`;
};

export class ProveStatusStep extends BaseStep {
  id = "prove-status";

  async detect(page: import("playwright").Page): Promise<boolean> {
    const link = page.getByRole("link", { name: /Get a share code/i });
    const href = page.locator('a[href$="/get-share-code"], a[href="/get-share-code"]');
    const hasGetShareCode =
      (await link.count().catch(() => 0)) > 0 || (await href.count().catch(() => 0)) > 0;

    return (
      hasGetShareCode &&
      ((await this.hasHeading(page, /Your immigration status/i)) ||
        (await this.hasHeading(page, /Prove your status/i)) ||
        (await this.hasLocator(page.locator(".govuk-summary-list__row"))))
    );
  }

  async execute(context: StepContext): Promise<void> {
    const { page, logger, options } = context;
    await this.dismissCookieBanner(context);
    await this.dismissStaySignedIn(context);
    await this.captureStatusHtml(context);

    logger.action("click", "get-share-code");
    await this.clickFirstAndWait(
      page,
      [
        {
          name: "Get a share code link",
          locator: page.getByRole("link", { name: /Get a share code/i }),
        },
        {
          name: "Get a share code button link",
          locator: page.locator('a.govuk-button:has-text("Get a share code")'),
        },
        {
          name: "get-share-code href",
          locator: page.locator('a[href$="/get-share-code"], a[href="/get-share-code"]'),
        },
      ],
      "Get a share code link",
      options.navigationTimeoutMs
    );
  }

  private checkerHtmlArtifact(context: StepContext): CheckerHtmlArtifact | undefined {
    const checker = (context.options as OptionsWithCheckerHtml).checker;
    if (!checker?.enabled || !checker.html?.enabled) {
      return undefined;
    }
    return checker.html;
  }

  private async captureStatusHtml(context: StepContext): Promise<void> {
    const artifact = this.checkerHtmlArtifact(context);
    if (!artifact) {
      return;
    }

    const { page, logger, options } = context;
    const summary = await this.readSummaryList(page).catch(
      (): Record<string, string> => ({})
    );
    if (Object.keys(summary).length > 0) {
      context.extractedData.summary ??= summary;
      context.extractedData.name ??= summary.Name;
      context.extractedData.dateOfBirth ??= summary["Date of birth"];
      context.extractedData.nationality ??= summary.Nationality;
      context.extractedData.status ??= summary.Status;
      context.extractedData.validFrom ??= summary["Valid from"];
      context.extractedData.validUntilText ??= summary["Valid until"];
    }

    await page
      .waitForLoadState("networkidle", {
        timeout: Math.min(options.navigationTimeoutMs, 10_000),
      })
      .catch(() => {});
    await page
      .evaluate(async () => {
        const delay = (ms: number): Promise<void> =>
          new Promise((resolve) => setTimeout(resolve, ms));
        window.scrollTo(0, document.body.scrollHeight);
        await delay(150);
        window.scrollTo(0, 0);
        await delay(50);
      })
      .catch(() => {});

    const html = await captureStandaloneHtml(page, {
      inlineImages: artifact.inlineImages,
      inlineStyles: artifact.inlineStyles,
      removeRuntimeChrome: true,
      assetMaxBytes: Math.min(artifact.maxBytes, 8 * 1024 * 1024),
      assetTimeoutMs: Math.min(options.actionTimeoutMs, 10_000),
    });
    const bytes = Buffer.from(html, "utf-8");
    if (bytes.byteLength > artifact.maxBytes) {
      throw new Error(
        `Standalone status HTML exceeded configured max size of ${artifact.maxBytes} bytes`
      );
    }

    const defaultFilename = `${statusHtmlBasename(summary)}.html`;
    if (artifact.mode === "bytes") {
      context.extractedData.checkerHtml = {
        kind: "bytes",
        bytes,
        filename: defaultFilename,
        contentType: "text/html",
        byteLength: bytes.byteLength,
        standalone: true,
      };
      logger.action("capture", "status-html-bytes");
      return;
    }

    const path = resolveOutputPath(artifact.directory, artifact.path, defaultFilename);
    await ensureParentDirectory(path);
    await writeFile(path, bytes);
    const ref: ArtifactRef = { kind: "html", path, sanitized: false };
    context.extractedData.checkerHtml = {
      kind: "file",
      path,
      filename: basename(path),
      contentType: "text/html",
      standalone: true,
    };
    context.extractedData.checkerHtmlArtifact = ref;
    context.emit({
      type: "artifact_saved",
      phase: context.classification?.phase ?? ("viewing_status" as EVisaPhase),
      artifact: ref,
    });
    logger.action("capture", "status-html");
  }
}
