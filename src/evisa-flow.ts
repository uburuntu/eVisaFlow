import { launchBrowser } from "./core/browser.js";
import { StepRunner, resolveOptions } from "./core/step-runner.js";
import type { EVisaFlowConfig, Purpose, RunResult } from "./types.js";
import { createLogger } from "./utils/logger.js";
import { EntryPageStep } from "./steps/entry-page.js";
import { DocumentTypeStep } from "./steps/document-type.js";
import { DocumentNumberStep } from "./steps/document-number.js";
import { DateOfBirthStep } from "./steps/date-of-birth.js";
import { TwoFactorMethodStep } from "./steps/two-factor-method.js";
import { TwoFactorCodeStep } from "./steps/two-factor-code.js";
import { ProveStatusStep } from "./steps/prove-status.js";
import { PurposeSelectionStep } from "./steps/purpose-selection.js";
import { ConfirmationStep } from "./steps/confirmation.js";
import { SummaryStep } from "./steps/summary.js";
import { DownloadPdfStep } from "./steps/download-pdf.js";

const START_URL =
  "https://www.gov.uk/evisa/view-evisa-get-share-code-prove-immigration-status";

const DEFAULT_PURPOSE: Purpose = "immigration_status_other";

export class EVisaFlow {
  private readonly config: EVisaFlowConfig;

  constructor(config: EVisaFlowConfig) {
    this.config = config;
  }

  async run(): Promise<RunResult> {
    const options = resolveOptions(this.config.options);
    const logger = createLogger({ verbose: options.verbose });
    const { browser, page, context } = await launchBrowser(options);

    const steps = [
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

    const runner = new StepRunner({
      steps,
      context: {
        credentials: this.config.credentials,
        purpose: this.config.purpose ?? DEFAULT_PURPOSE,
        options,
        logger,
        page,
        extractedData: {},
        onTwoFactorRequired: this.config.onTwoFactorRequired,
      },
    });

    try {
      return await runner.run(START_URL);
    } catch (error) {
      logger.error("Flow failed", { error });
      if (options.screenshotOnError) {
        await runner.captureDebug("error");
      }
      throw error;
    } finally {
      await context.close();
      if (browser) {
        await browser.close();
      }
    }
  }
}
