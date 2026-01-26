import { BaseStep } from "./base-step.js";
import { HEADINGS } from "../utils/selectors.js";
import type { StepContext } from "../types.js";

export class ConfirmationStep extends BaseStep {
  id = "confirmation";

  async detect(page: import("playwright").Page): Promise<boolean> {
    return this.hasHeading(page, HEADINGS.confirmation);
  }

  async execute(context: StepContext): Promise<void> {
    const { page, logger } = context;
    // Some sessions show a "Stay signed in" dialog.
    try {
      const staySignedIn = page.getByRole("button", { name: /Stay signed in/i });
      if ((await staySignedIn.count()) > 0) {
        logger.action("click", "stay-signed-in");
        await staySignedIn.first().click();
      }
    } catch {
      // Ignore if dialog not present.
    }

    logger.action("click", "get-share-code");
    const linkByRole = page.getByRole("link", { name: /Get share code/i });
    const linkBySelector = page.locator('a.govuk-button:has-text("Get share code")');
    const linkByHref = page.locator('a[href="/share"]');

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
