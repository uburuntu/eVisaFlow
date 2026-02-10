import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Step, StepContext, RunResult, RunOptions } from "../types.js";
import { detectStep } from "./page-detector.js";
import { PageDetectionError } from "../errors/index.js";

export interface StepRunnerOptions {
  steps: Step[];
  context: Omit<StepContext, "setResult">;
}

export class StepRunner {
  private readonly steps: Step[];
  private readonly context: StepContext;
  private result: RunResult | undefined;
  private readonly debugDir: string;

  constructor(options: StepRunnerOptions) {
    this.steps = options.steps;
    this.debugDir = join(options.context.options.outputDir, "debug");
    this.context = {
      ...options.context,
      setResult: (result: RunResult) => {
        this.result = result;
      },
    };
  }

  async run(startUrl: string): Promise<RunResult> {
    const { page, logger } = this.context;
    await mkdir(this.context.options.outputDir, { recursive: true });
    await mkdir(this.debugDir, { recursive: true });

    logger.info("Navigating to start URL", { startUrl });
    await page.goto(startUrl, { waitUntil: "domcontentloaded" });

    const maxSteps = 30;
    for (let i = 0; i < maxSteps; i += 1) {
      const step = await detectStep(this.steps, page);
      if (!step) {
        await this.captureDebug("unknown-page");
        throw new PageDetectionError("Unable to detect current page");
      }

      logger.step(step.id, "Executing step");
      if (this.context.options.verbose) {
        await this.captureDebug(`step-${step.id}`);
      }

      await step.execute(this.context);

      if (this.result) {
        return this.result;
      }
    }

    throw new PageDetectionError(
      "Exceeded maximum number of steps without completion"
    );
  }

  async captureDebug(label: string): Promise<void> {
    const { page, logger } = this.context;
    const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_");
    const screenshotPath = join(this.debugDir, `${safeLabel}.png`);
    const htmlPath = join(this.debugDir, `${safeLabel}.html`);

    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      logger.screenshot(screenshotPath);
    } catch (error) {
      logger.warn("Failed to capture screenshot", { error });
    }

    try {
      const html = await page.content();
      await writeFile(htmlPath, html, "utf-8");
    } catch (error) {
      logger.warn("Failed to capture HTML", { error });
    }
  }
}

export const resolveOptions = (options?: RunOptions): Required<RunOptions> => {
  return {
    headless: options?.headless ?? true,
    verbose: options?.verbose ?? false,
    screenshotOnError: options?.screenshotOnError ?? true,
    outputDir: options?.outputDir ?? "downloads",
    outputFile: options?.outputFile ?? "",
    userDataDir: options?.userDataDir ?? "",
    navigationTimeoutMs: options?.navigationTimeoutMs ?? 60_000,
    actionTimeoutMs: options?.actionTimeoutMs ?? 30_000,
    twoFactorTimeoutMs: options?.twoFactorTimeoutMs ?? 10 * 60_000,
  };
};
