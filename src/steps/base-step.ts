import type { Page, Locator } from "playwright";
import type { Step, StepContext } from "../types.js";

export abstract class BaseStep implements Step {
  abstract id: string;
  abstract detect(page: Page): Promise<boolean>;
  abstract execute(context: StepContext): Promise<void>;

  protected heading(page: Page, name: string): Locator {
    return page.getByRole("heading", { name });
  }

  protected async hasHeading(page: Page, name: string): Promise<boolean> {
    try {
      const heading = this.heading(page, name);
      await heading.first().waitFor({ timeout: 2000, state: "attached" }).catch(() => {});
      return (await heading.count()) > 0;
    } catch {
      return false;
    }
  }

  protected async waitForElement(
    page: Page,
    selector: string,
    timeout = 30000
  ): Promise<void> {
    await page.waitForSelector(selector, { timeout, state: "visible" });
  }

  protected async safeClick(
    page: Page,
    selector: string | Locator,
    timeout = 30000
  ): Promise<void> {
    const locator =
      typeof selector === "string" ? page.locator(selector) : selector;
    await locator.waitFor({ state: "visible", timeout });
    await locator.click();
  }

  protected async dismissStaySignedIn(context: StepContext): Promise<void> {
    const { page, logger } = context;
    try {
      const staySignedIn = page.getByRole("button", { name: /Stay signed in/i });
      if ((await staySignedIn.count()) > 0) {
        logger.action("click", "stay-signed-in");
        await staySignedIn.first().click();
      }
    } catch {
      // Ignore — dialog may not be present
    }
  }

  protected async dismissCookieBanner(context: StepContext): Promise<void> {
    const { page, logger } = context;
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
      // Ignore — cookie banner may not be present
    }
  }
}
