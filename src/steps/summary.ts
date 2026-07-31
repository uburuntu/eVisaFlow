import type { StepContext } from "../core/internal-types.js";
import { BaseStep } from "./base-step.js";

export class SummaryStep extends BaseStep {
  id = "summary";

  async execute(context: StepContext): Promise<void> {
    const { page, logger, options } = context;
    await this.dismissStaySignedIn(context);
    await this.dismissCookieBanner(context);

    // Extract non-secret profile details before navigating away; values are used
    // only for result metadata and the default PDF filename.
    try {
      const summary = await this.readSummaryList(page);
      context.extractedData.summary = summary;
      context.extractedData.name = summary.Name;
      context.extractedData.dateOfBirth = summary["Date of birth"];
      context.extractedData.nationality = summary.Nationality;
      context.extractedData.status = summary.Status;
      context.extractedData.validFrom = summary["Valid from"];
      context.extractedData.validUntilText = summary["Valid until"];
      logger.debug("Extracted summary fields", {
        fields: Object.keys(summary),
      });
    } catch {
      logger.warn("Failed to extract name from summary page");
    }

    logger.action("click", "create-share-code");
    await this.clickFirstAndWait(
      page,
      [
        {
          name: "Create a share code link",
          locator: page.getByRole("link", { name: /Create (a )?share code/i }),
        },
        {
          name: "Create a share code button",
          locator: page.getByRole("button", { name: /Create (a )?share code/i }),
        },
        {
          name: "Create a share code button link",
          locator: page.locator(
            'a.govuk-button:has-text("Create a share code"), a.govuk-button:has-text("Create share code")'
          ),
        },
        {
          name: "share code href",
          locator: page.locator('a[href^="/share/"][href$="/code"]'),
        },
      ],
      "Create a share code link",
      options.navigationTimeoutMs
    );
  }
}
