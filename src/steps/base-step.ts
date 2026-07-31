import type { Locator, Page } from "playwright";
import type { Step, StepContext } from "../core/internal-types.js";
import {
  checkFirst,
  clickFirstAndWait,
  fillFirst,
  findFirst,
  hasVisible,
  type LocatorCandidate,
  normalizeText,
  readSummaryList,
} from "../core/page-actions.js";

export const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export abstract class BaseStep implements Step {
  abstract id: string;
  abstract execute(context: StepContext): Promise<void>;

  protected async hasVisible(locator: Locator, limit = 5): Promise<boolean> {
    return hasVisible(locator, limit);
  }

  protected async findFirst(
    candidates: LocatorCandidate[],
    purpose: string,
    timeout = 5000
  ): Promise<Locator> {
    return findFirst(candidates, purpose, timeout);
  }

  protected async fillFirst(
    candidates: LocatorCandidate[],
    value: string,
    purpose: string,
    timeout = 5000
  ): Promise<void> {
    await fillFirst(candidates, value, purpose, timeout);
  }

  protected async checkFirst(
    candidates: LocatorCandidate[],
    purpose: string,
    timeout = 5000
  ): Promise<void> {
    await checkFirst(candidates, purpose, timeout);
  }

  protected async clickFirstAndWait(
    page: Page,
    candidates: LocatorCandidate[],
    purpose: string,
    timeout = 30000
  ): Promise<void> {
    await clickFirstAndWait(page, candidates, purpose, timeout);
  }

  protected async submitContinue(context: StepContext): Promise<void> {
    const { page, options } = context;
    await this.clickFirstAndWait(
      page,
      [
        {
          name: "button role named Continue",
          locator: page.getByRole("button", { name: /^Continue$/i }),
        },
        {
          name: "submit button with Continue text",
          locator: page.locator('button[type="submit"]:has-text("Continue")'),
        },
        {
          name: "submit button with Continue aria-label",
          locator: page.locator('button[aria-label="Continue"]'),
        },
        {
          name: "submit input with Continue value",
          locator: page.locator('input[type="submit"][value="Continue"]'),
        },
      ],
      "Continue button",
      options.navigationTimeoutMs
    );
  }

  protected async pageText(page: Page): Promise<string> {
    return normalizeText(await page.locator("body").innerText());
  }

  protected async readSummaryList(page: Page): Promise<Record<string, string>> {
    return readSummaryList(page);
  }

  protected async dismissStaySignedIn(context: StepContext): Promise<void> {
    const { page, logger } = context;
    try {
      const staySignedIn = page.getByRole("button", {
        name: /Stay signed in/i,
      });
      if (await this.hasVisible(staySignedIn)) {
        logger.action("click", "stay-signed-in");
        await staySignedIn.first().click();
      }
    } catch {
      // Ignore: the timeout dialog is optional.
    }
  }

  protected async dismissCookieBanner(context: StepContext): Promise<void> {
    const { page, logger } = context;
    try {
      const reject = page.getByRole("button", {
        name: /Reject (analytics|additional|all)/i,
      });
      const accept = page.getByRole("button", {
        name: /Accept (analytics|additional|all)/i,
      });
      const hide = page.getByRole("button", { name: /Hide this message/i });

      if (await this.hasVisible(reject)) {
        logger.action("click", "reject-nonessential-cookies");
        await reject.first().click();
      } else if (await this.hasVisible(accept)) {
        logger.action("click", "accept-cookie-banner");
        await accept.first().click();
      } else if (await this.hasVisible(hide)) {
        logger.action("click", "hide-cookie-banner");
        await hide.first().click();
      }
    } catch {
      // Ignore: the cookie banner varies by GOV.UK/Home Office frontend.
    }
  }
}
