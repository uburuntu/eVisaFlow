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

    // Handle analytics cookie banner if present.
    try {
      const accept = page.getByRole("button", { name: /Accept analytics cookies/i });
      const reject = page.getByRole("button", { name: /Reject analytics cookies/i });
      if ((await accept.count()) > 0) {
        logger.action("click", "accept-analytics-cookies");
        await accept.click();
      } else if ((await reject.count()) > 0) {
        logger.action("click", "reject-analytics-cookies");
        await reject.click();
      }
    } catch {
      // Ignore if cookie banner not present.
    }

    logger.action("click", "create-share-code");
    // "Create a share code" is a link styled as a button on this page.
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
