import type { StepContext } from "../core/internal-types.js";
import { BaseStep } from "./base-step.js";

export class EntryPageStep extends BaseStep {
  id = "entry-page";

  async execute(context: StepContext): Promise<void> {
    const { page, logger, options } = context;
    await this.dismissCookieBanner(context);

    logger.action("click", "entry-start");
    await this.clickFirstAndWait(
      page,
      [
        {
          name: "start link to view immigration status",
          locator: page.locator(
            'a[href*="view-immigration-status.service.gov.uk/status"]'
          ),
        },
        {
          name: "View your eVisa link",
          locator: page.getByRole("link", {
            name: /View your eVisa and get a share code/i,
          }),
        },
        {
          name: "GOV.UK start button",
          locator: page.locator("a.govuk-button--start, a.gem-c-button"),
        },
      ],
      "eVisa start link",
      options.navigationTimeoutMs
    );
  }
}
