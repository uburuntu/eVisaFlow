import { BaseStep } from "./base-step.js";
import { HEADINGS, SELECTORS } from "../utils/selectors.js";

export class EntryPageStep extends BaseStep {
  id = "entry-page";

  async detect(page: import("playwright").Page): Promise<boolean> {
    return this.hasHeading(page, HEADINGS.entry);
  }

  async execute(context: import("../types.js").StepContext): Promise<void> {
    const { page, logger } = context;
    
    // Handle cookie consent if present
    try {
      const acceptCookies = page.getByRole("button", { name: /Accept additional cookies/i });
      if ((await acceptCookies.count()) > 0) {
        logger.action("click", "accept-cookies");
        await acceptCookies.click();
        await page.waitForTimeout(500);
      }
    } catch {
      logger.debug("No cookie banner found or already handled");
    }
    
    logger.action("click", "entry-start");
    // Try multiple selectors for robustness
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
