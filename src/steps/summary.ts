import { BaseStep } from "./base-step.js";
import { HEADINGS } from "../utils/selectors.js";
import type { StepContext } from "../types.js";

export class SummaryStep extends BaseStep {
  id = "summary";

  async detect(page: import("playwright").Page): Promise<boolean> {
    return this.hasHeading(page, HEADINGS.summary);
  }

  async execute(context: StepContext): Promise<void> {
    const { page, logger } = context;
    await this.dismissStaySignedIn(context);
    await this.dismissCookieBanner(context);

    // Extract name and valid-until from the summary table before navigating away.
    try {
      const nameCell = page.locator('dt.govuk-summary-list__key:has-text("Name") + dd');
      if ((await nameCell.count()) > 0) {
        context.extractedData.name = (await nameCell.first().textContent())?.trim();
        logger.debug("Extracted name from summary", { name: context.extractedData.name });
      }
    } catch {
      logger.warn("Failed to extract name from summary page");
    }

    try {
      const validUntilCell = page.locator('dt.govuk-summary-list__key:has-text("Valid until") + dd');
      if ((await validUntilCell.count()) > 0) {
        context.extractedData.validUntil = (await validUntilCell.first().textContent())?.trim();
        logger.debug("Extracted valid-until from summary", { validUntil: context.extractedData.validUntil });
      }
    } catch {
      logger.warn("Failed to extract valid-until from summary page");
    }

    logger.action("click", "create-share-code");
    const linkByRole = page.getByRole("link", { name: /Create a share code/i });
    const linkBySelector = page.locator('a.govuk-button:has-text("Create a share code")');
    const linkByHref = page.locator('a[href^="/share/"][href$="/code"]');

    if ((await linkByRole.count()) > 0) {
      await linkByRole.first().click();
    } else if ((await linkBySelector.count()) > 0) {
      await linkBySelector.first().click();
    } else {
      await linkByHref.first().click();
    }
    await page.waitForLoadState("domcontentloaded");
  }
}
