import type { StepContext, TwoFactorMethod } from "../core/internal-types.js";
import { FlowCancelledError, TwoFactorTimeoutError } from "../errors/index.js";
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
    const challengeSignal = context.signal
      ? AbortSignal.any([abortController.signal, context.signal])
      : abortController.signal;
    const handlerPromise = context.onTwoFactorRequired(method, {
      deadlineMs,
      signal: challengeSignal,
    });
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;
    const timeoutPromise = new Promise<string>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new TwoFactorTimeoutError("Timed out waiting for 2FA code"));
      }, options.twoFactorTimeoutMs);
    });
    const abortPromise = new Promise<string>((_, reject) => {
      const rejectAborted = () => {
        const reason = challengeSignal.reason;
        reject(
          reason instanceof Error
            ? new FlowCancelledError(reason.message, { cause: reason })
            : new FlowCancelledError(
                typeof reason === "string" ? reason : "Flow cancelled"
              )
        );
      };

      if (challengeSignal.aborted) {
        rejectAborted();
        return;
      }

      challengeSignal.addEventListener("abort", rejectAborted, { once: true });
      removeAbortListener = () =>
        challengeSignal.removeEventListener("abort", rejectAborted);
    });

    let code: string;
    try {
      code = await Promise.race([handlerPromise, timeoutPromise, abortPromise]);
    } finally {
      abortController.abort();
      removeAbortListener?.();
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
