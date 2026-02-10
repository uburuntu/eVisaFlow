import { BaseStep } from "./base-step.js";
import { HEADINGS, SELECTORS } from "../utils/selectors.js";
import type { StepContext } from "../types.js";

export class EntryPageStep extends BaseStep {
  id = "entry-page";

  async detect(page: import("playwright").Page): Promise<boolean> {
    return this.hasHeading(page, HEADINGS.entry);
  }

  async execute(context: StepContext): Promise<void> {
    const { page, logger } = context;
    await this.dismissCookieBanner(context);

    logger.action("click", "entry-start");
    const buttonByRole = page.getByRole("link", { name: /View your eVisa and get a share code/i });
    const buttonByHref = page.locator('a[href*="view-immigration-status"]');
    const buttonBySelector = page.locator(SELECTORS.entryStartButton);

    if ((await buttonByRole.count()) > 0) {
      await buttonByRole.first().click();
    } else if ((await buttonByHref.count()) > 0) {
      await buttonByHref.first().click();
    } else {
      await buttonBySelector.first().click();
    }
    await page.waitForLoadState("domcontentloaded");
  }
}
