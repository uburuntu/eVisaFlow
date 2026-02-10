import { BaseStep } from "./base-step.js";
import { HEADINGS } from "../utils/selectors.js";
import type { StepContext, TwoFactorMethod } from "../types.js";
import { TwoFactorTimeoutError } from "../errors/index.js";

const inferMethod = async (
  page: import("playwright").Page
): Promise<TwoFactorMethod> => {
  if (await page.getByRole("heading", { name: HEADINGS.twoFactorCodePhone }).count()) {
    return "sms";
  }
  if (await page.getByRole("heading", { name: HEADINGS.twoFactorCodeEmail }).count()) {
    return "email";
  }
  return "sms";
};

export class TwoFactorCodeStep extends BaseStep {
  id = "two-factor-code";

  async detect(page: import("playwright").Page): Promise<boolean> {
    return (
      (await page.getByLabel("Security code").count()) > 0 &&
      ((await this.hasHeading(page, HEADINGS.twoFactorCodePhone)) ||
        (await this.hasHeading(page, HEADINGS.twoFactorCodeEmail)))
    );
  }

  async execute(context: StepContext): Promise<void> {
    const { page, logger, options } = context;
    const method = await inferMethod(page);
    const deadlineMs = Date.now() + options.twoFactorTimeoutMs;
    logger.info("Awaiting two-factor code", { method });

    const handlerPromise = context.onTwoFactorRequired(method, {
      deadlineMs,
    });
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<string>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new TwoFactorTimeoutError("Timed out waiting for 2FA code"));
      }, options.twoFactorTimeoutMs);
    });

    let code: string;
    try {
      code = await Promise.race([handlerPromise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
    await page.getByLabel("Security code").fill(code);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForLoadState("domcontentloaded");
  }
}
