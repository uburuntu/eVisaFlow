import type { StepContext } from "../core/internal-types.js";
import { BaseStep } from "./base-step.js";

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
}
