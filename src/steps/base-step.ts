import type { Locator, Page } from "playwright";
import type { Step, StepContext } from "../core/internal-types.js";
import { SelectorNotFoundError } from "../errors/index.js";

interface LocatorCandidate {
  name: string;
  locator: Locator;
}

export const normalizeText = (value: string | null | undefined): string =>
  (value ?? "").replace(/\s+/g, " ").trim();

export const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export abstract class BaseStep implements Step {
  abstract id: string;
  abstract detect(page: Page): Promise<boolean>;
  abstract execute(context: StepContext): Promise<void>;

  protected heading(page: Page, name: string | RegExp): Locator {
    return page.getByRole("heading", { name });
  }

  protected async hasHeading(page: Page, name: string | RegExp): Promise<boolean> {
    return this.hasVisible(this.heading(page, name));
  }

  protected async hasText(page: Page, pattern: RegExp): Promise<boolean> {
    return this.hasVisible(page.locator("body").filter({ hasText: pattern }));
  }

  protected async hasVisible(locator: Locator, limit = 5): Promise<boolean> {
    const count = Math.min(await locator.count().catch(() => 0), limit);
    for (let index = 0; index < count; index += 1) {
      if (
        await locator
          .nth(index)
          .isVisible()
          .catch(() => false)
      ) {
        return true;
      }
    }
    return false;
  }

  protected async hasLocator(locator: Locator): Promise<boolean> {
    return (await locator.count().catch(() => 0)) > 0;
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
    const locator = typeof selector === "string" ? page.locator(selector) : selector;
    await locator.click({ timeout });
  }

  protected async findFirst(
    candidates: LocatorCandidate[],
    purpose: string,
    timeout = 5000
  ): Promise<Locator> {
    const deadline = Date.now() + timeout;

    while (Date.now() <= deadline) {
      for (const candidate of candidates) {
        const count = await candidate.locator.count().catch(() => 0);
        if (count > 0) {
          return candidate.locator.first();
        }
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
    }

    throw new SelectorNotFoundError(
      `Could not find ${purpose}. Tried: ${candidates
        .map((candidate) => candidate.name)
        .join(", ")}`
    );
  }

  protected async fillFirst(
    candidates: LocatorCandidate[],
    value: string,
    purpose: string,
    timeout = 5000
  ): Promise<void> {
    const locator = await this.findFirst(candidates, purpose, timeout);
    await locator.waitFor({ state: "visible", timeout });
    await locator.fill(value);
  }

  protected async checkFirst(
    candidates: LocatorCandidate[],
    purpose: string,
    timeout = 5000
  ): Promise<void> {
    const locator = await this.findFirst(candidates, purpose, timeout);
    await locator.check({ timeout });
  }

  protected async clickAndWait(
    page: Page,
    locator: Locator,
    timeout = 30000
  ): Promise<void> {
    await locator.click({ timeout });
    await page
      .locator("body")
      .waitFor({ state: "attached", timeout: Math.min(timeout, 5_000) })
      .catch(() => {});
  }

  protected async clickFirstAndWait(
    page: Page,
    candidates: LocatorCandidate[],
    purpose: string,
    timeout = 30000
  ): Promise<void> {
    const locator = await this.findFirst(candidates, purpose, timeout);
    await this.clickAndWait(page, locator, timeout);
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
    const rows = await page.locator(".govuk-summary-list__row").evaluateAll(
      (elements): Array<[string, string]> =>
        elements
          .map((element) => {
            const key = element.querySelector(
              ".govuk-summary-list__key, dt"
            )?.textContent;
            const value = element.querySelector(
              ".govuk-summary-list__value, dd"
            )?.textContent;
            const normalizedKey = (key ?? "").replace(/\s+/g, " ").trim();
            const normalizedValue = (value ?? "").replace(/\s+/g, " ").trim();
            return [normalizedKey, normalizedValue] as [string, string];
          })
          .filter(([key, value]) => key.length > 0 && value.length > 0)
    );

    return Object.fromEntries(rows);
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
