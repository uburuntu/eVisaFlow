import type { StepContext } from "../core/internal-types.js";
import { BaseStep } from "./base-step.js";

export class ConfirmationStep extends BaseStep {
  id = "confirmation";

  async detect(page: import("playwright").Page): Promise<boolean> {
    const hasShareLink =
      (await page.getByRole("link", { name: /^Get share code$/i }).count()) > 0 ||
      (await page.locator('a[href="/share"]').count()) > 0;

    return (
      hasShareLink &&
      (await this.hasHeading(page, /Get a share code to prove your status/i))
    );
  }

  async execute(context: StepContext): Promise<void> {
    const { page, logger, options } = context;
    await this.dismissStaySignedIn(context);

    logger.action("click", "get-share-code");
    await this.clickFirstAndWait(
      page,
      [
        {
          name: "Get share code link",
          locator: page.getByRole("link", { name: /^Get share code$/i }),
        },
        {
          name: "Get share code button link",
          locator: page.locator('a.govuk-button:has-text("Get share code")'),
        },
        { name: "share href", locator: page.locator('a[href="/share"]') },
      ],
      "Get share code link",
      options.navigationTimeoutMs
    );
  }
}
