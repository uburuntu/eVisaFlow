import type { StepContext, TwoFactorMethod } from "../core/internal-types.js";
import { TwoFactorTimeoutError } from "../errors/index.js";
import { BaseStep } from "./base-step.js";

const inferMethod = async (page: import("playwright").Page): Promise<TwoFactorMethod> => {
  const headingText = (
    await page
      .locator("h1")
      .first()
      .innerText()
      .catch(() => "")
  ).trim();
  if (/email/i.test(headingText)) {
    return "email";
  }
  if (/phone|text message|SMS/i.test(headingText)) {
    return "sms";
  }

  if (
    await page
      .locator("body")
      .filter({ hasText: /sent you .*security code by email/i })
      .count()
  ) {
    return "email";
  }
  if (
    await page
      .locator("body")
      .filter({ hasText: /sent you .*security code by (text message|SMS)/i })
      .count()
  ) {
    return "sms";
  }
  return "sms";
};

export class TwoFactorCodeStep extends BaseStep {
  id = "two-factor-code";

  async detect(page: import("playwright").Page): Promise<boolean> {
    const hasCodeInput = await this.hasLocator(
      page.locator(
        'input[name="verificationCode"], input#verificationCode, input[name="code"], input#code'
      )
    );
    if (!hasCodeInput) {
      return false;
    }

    return (
      (await this.hasHeading(page, /Check your (phone|email)/i)) ||
      (await this.hasText(page, /Security code/i))
    );
  }

  async execute(context: StepContext): Promise<void> {
    const { page, logger, options } = context;
    const method = await inferMethod(page);
    const deadlineMs = Date.now() + options.twoFactorTimeoutMs;
    logger.info("Awaiting two-factor code", { method });

    const abortController = new AbortController();
    const handlerPromise = context.onTwoFactorRequired(method, {
      deadlineMs,
      signal: abortController.signal,
    });
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<string>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new TwoFactorTimeoutError("Timed out waiting for 2FA code"));
      }, options.twoFactorTimeoutMs);
    });

    let code: string;
    try {
      code = await Promise.race([handlerPromise, timeoutPromise]);
    } finally {
      abortController.abort();
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
    await this.fillFirst(
      [
        {
          name: "verificationCode input",
          locator: page.locator('input[name="verificationCode"], input#verificationCode'),
        },
        {
          name: "code input",
          locator: page.locator('input[name="code"], input#code'),
        },
        {
          name: "Security code label",
          locator: page.getByLabel(/Security code/i),
        },
      ],
      code.trim(),
      "security code"
    );
    await this.submitContinue(context);
  }
}
