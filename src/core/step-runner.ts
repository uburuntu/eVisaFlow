import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AuthenticationError,
  EVisaError,
  PageDetectionError,
  ServiceUnavailableError,
  SessionExpiredError,
} from "../errors/index.js";
import type { ArtifactRef, EVisaEvent } from "../types.js";
import type { InternalRunResult, Step, StepContext } from "./internal-types.js";
import { classifyPage, type PageKind } from "./page-classifier.js";
import {
  createPageSnapshot,
  createSanitizedDiagnosticSnapshot,
} from "./page-snapshot.js";

export interface StepRunnerOptions {
  steps: Step[];
  context: Omit<StepContext, "setResult" | "addArtifacts">;
}

const stepIdByKind: Partial<Record<PageKind, string>> = {
  entry_page: "entry-page",
  document_type: "document-type",
  document_number: "document-number",
  date_of_birth: "date-of-birth",
  two_factor_method: "two-factor-method",
  two_factor_code: "two-factor-code",
  prove_status: "prove-status",
  confirmation: "confirmation",
  purpose_selection: "purpose-selection",
  summary: "summary",
  download_pdf: "download-pdf",
};

const durationMs = (startedAt: number): number =>
  Math.round((Date.now() - startedAt) * 100) / 100;

const sanitizeUrl = (value: string): string => {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.split(/[?#]/, 1)[0] ?? value;
  }
};

export class StepRunner {
  private readonly steps: Step[];
  private readonly context: StepContext;
  private result: InternalRunResult | undefined;
  private readonly artifacts: ArtifactRef[] = [];

  constructor(options: StepRunnerOptions) {
    this.steps = options.steps;
    this.context = {
      ...options.context,
      setResult: (result: InternalRunResult) => {
        this.result = result;
      },
      addArtifacts: (artifacts: ArtifactRef[]) => {
        this.artifacts.push(...artifacts);
        for (const artifact of artifacts) {
          this.context.emit({
            type: "artifact_saved",
            phase: this.context.classification?.phase ?? "launching",
            artifact,
          });
        }
      },
    };
  }

  private emitTiming(
    operation: Extract<EVisaEvent, { type: "timing" }>["operation"],
    startedAt: number,
    metadata: Omit<
      Extract<EVisaEvent, { type: "timing" }>,
      "type" | "operation" | "durationMs"
    >
  ): void {
    this.context.emit({
      type: "timing",
      operation,
      durationMs: durationMs(startedAt),
      ...metadata,
    });
  }

  async run(startUrl: string): Promise<InternalRunResult> {
    const { page, logger } = this.context;
    const runStartedAt = Date.now();
    if (this.context.options.pdfEnabled && this.context.options.pdfOutput === "file") {
      await mkdir(this.context.options.outputDir, { recursive: true });
    }

    try {
      logger.info("Navigating to start URL", { startUrl });
      const navigationStartedAt = Date.now();
      await page.goto(startUrl, { waitUntil: "domcontentloaded" });
      await page.locator("body").waitFor({ state: "attached" });
      this.emitTiming("navigate", navigationStartedAt, {
        phase: "launching",
        url: page.url(),
      });

      const maxSteps = 30;
      for (let i = 0; i < maxSteps; i += 1) {
        const snapshotStartedAt = Date.now();
        const snapshot = await createPageSnapshot(page);
        const classification = classifyPage(snapshot);
        this.context.classification = classification;
        this.emitTiming("page_snapshot", snapshotStartedAt, {
          phase: classification.phase,
          pageKind: classification.kind,
          url: snapshot.url,
        });
        this.context.emit({
          type: "page_classified",
          phase: classification.phase,
          pageKind: classification.kind,
          confidence: classification.confidence,
          evidence: classification.evidence,
        });

        if (classification.kind === "session_expired") {
          throw new SessionExpiredError(snapshot.errors.join(" ") || "Session expired", {
            phase: classification.phase,
            pageKind: classification.kind,
          });
        }
        if (classification.kind === "auth_error") {
          throw new AuthenticationError(
            snapshot.errors.join(" ") || "Authentication failed",
            {
              phase: classification.phase,
              pageKind: classification.kind,
            }
          );
        }
        if (classification.kind === "service_unavailable") {
          throw new ServiceUnavailableError("GOV.UK service is unavailable", {
            phase: classification.phase,
            pageKind: classification.kind,
            retryable: true,
          });
        }

        const stepId = stepIdByKind[classification.kind];
        const step = stepId
          ? this.steps.find((candidate) => candidate.id === stepId)
          : undefined;
        if (!step) {
          const artifactRefs = await this.captureDebug("unknown-page");
          throw new PageDetectionError(
            [
              "Unable to detect current page",
              `url=${sanitizeUrl(snapshot.url)}`,
              `title=${snapshot.title}`,
              `headings=${snapshot.headings.join(" | ")}`,
              `evidence=${classification.evidence.join(", ")}`,
            ]
              .filter(Boolean)
              .join("\n"),
            {
              phase: classification.phase,
              pageKind: classification.kind,
              artifactRefs,
            }
          );
        }

        logger.step(step.id, "Executing step");
        this.context.emit({ type: "phase_changed", phase: classification.phase });

        if (
          this.context.options.diagnosticsMode === "sanitized" ||
          this.context.options.diagnosticsMode === "raw"
        ) {
          await this.captureDebug(`${String(i + 1).padStart(2, "0")}-${step.id}`);
        }

        const stepStartedAt = Date.now();
        await step.execute(this.context);
        this.emitTiming("step", stepStartedAt, {
          phase: classification.phase,
          stepId: step.id,
          pageKind: classification.kind,
          url: snapshot.url,
        });

        if (this.result) {
          return {
            ...this.result,
            artifacts: this.artifacts.length
              ? [...this.artifacts, ...(this.result.artifacts ?? [])]
              : this.result.artifacts,
          };
        }
      }

      const artifactRefs = await this.captureDebug("max-steps");
      throw new PageDetectionError(
        "Exceeded maximum number of steps without completion",
        {
          artifactRefs,
        }
      );
    } catch (error) {
      if (
        this.context.options.diagnosticsMode === "sanitized_on_failure" &&
        !(error instanceof EVisaError && error.artifactRefs.length > 0)
      ) {
        const artifactRefs = await this.captureDebug("failure").catch(() => []);
        if (artifactRefs.length > 0) {
          if (error instanceof EVisaError) {
            error.artifactRefs.push(...artifactRefs);
          } else {
            throw new EVisaError(error instanceof Error ? error.message : String(error), {
              artifactRefs,
              cause: error,
            });
          }
        }
      }
      throw error;
    } finally {
      this.emitTiming("run", runStartedAt, {
        phase: this.context.classification?.phase ?? "launching",
        pageKind: this.context.classification?.kind,
        url: page.url(),
      });
    }
  }

  async captureDebug(label: string): Promise<ArtifactRef[]> {
    const { page, logger, options } = this.context;
    if (options.diagnosticsMode === "off") {
      return [];
    }

    const captureStartedAt = Date.now();
    await mkdir(options.diagnosticsDir, { recursive: true });
    const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_");
    const refs: ArtifactRef[] = [];

    if (
      options.diagnosticsMode === "sanitized" ||
      options.diagnosticsMode === "sanitized_on_failure"
    ) {
      try {
        const snapshot = await createPageSnapshot(page);
        const snapshotPath = join(options.diagnosticsDir, `${safeLabel}.snapshot.json`);
        await writeFile(
          snapshotPath,
          JSON.stringify(createSanitizedDiagnosticSnapshot(snapshot), null, 2),
          "utf-8"
        );
        refs.push({ kind: "snapshot", path: snapshotPath, sanitized: true });
      } catch (error) {
        logger.warn("Failed to capture sanitized snapshot", { error });
      }
    }

    if (options.diagnosticsMode === "raw") {
      const screenshotPath = join(options.diagnosticsDir, `${safeLabel}.png`);
      const htmlPath = join(options.diagnosticsDir, `${safeLabel}.html`);

      try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        logger.screenshot(screenshotPath);
        refs.push({ kind: "screenshot", path: screenshotPath, sanitized: false });
      } catch (error) {
        logger.warn("Failed to capture screenshot", { error });
      }

      try {
        const html = await page.content();
        await writeFile(htmlPath, html, "utf-8");
        refs.push({ kind: "html", path: htmlPath, sanitized: false });
      } catch (error) {
        logger.warn("Failed to capture HTML", { error });
      }
    }

    this.context.addArtifacts(refs);
    this.emitTiming("diagnostic_capture", captureStartedAt, {
      phase: this.context.classification?.phase ?? "launching",
      pageKind: this.context.classification?.kind,
      url: page.url(),
    });
    return refs;
  }
}

export const emitSafe = (emit: ((event: EVisaEvent) => void) | undefined) => {
  return (event: EVisaEvent): void => {
    try {
      emit?.(event);
    } catch {
      // Consumer event handlers must not affect the browser automation.
    }
  };
};
