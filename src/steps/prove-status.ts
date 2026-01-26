import { BaseStep } from "./base-step.js";
import { HEADINGS } from "../utils/selectors.js";
import type { StepContext } from "../types.js";

export class ProveStatusStep extends BaseStep {
  id = "prove-status";

  async detect(page: import("playwright").Page): Promise<boolean> {
    const statusHeading = await this.hasHeading(page, HEADINGS.status);
    const proveHeading = await this.hasHeading(page, HEADINGS.proveStatus);
    const link = page.getByRole("link", { name: /Get a share code/i });
    const href = page.locator('a[href="/get-share-code"]');
    return (statusHeading || proveHeading) && ((await link.count()) > 0 || (await href.count()) > 0);
  }

  async execute(context: StepContext): Promise<void> {
    const { page, logger } = context;
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
    // "Get a share code" is a link styled as a button on this page.
    const linkByRole = page.getByRole("link", { name: /Get a share code/i });
    const linkBySelector = page.locator('a.govuk-button:has-text("Get a share code")');
    const linkByHref = page.locator('a[href="/get-share-code"]');

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
