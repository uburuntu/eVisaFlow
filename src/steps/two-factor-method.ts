import type { StepContext, TwoFactorMethod } from "../core/internal-types.js";
import { SelectorNotFoundError } from "../errors/index.js";
import { BaseStep } from "./base-step.js";

export class TwoFactorMethodStep extends BaseStep {
  id = "two-factor-method";

  async detect(page: import("playwright").Page): Promise<boolean> {
    if (await this.hasLocator(page.locator('input[name="deliveryMethod"]'))) {
      return true;
    }

    return this.hasHeading(page, /receive a security code/i);
  }

  private async chooseMethod(
    context: StepContext,
    preferred?: TwoFactorMethod
  ): Promise<void> {
    const { page, logger } = context;
    const sms = page.locator('input[name="deliveryMethod"][value="SMS"]');
    const smsByRole = page.getByRole("radio", { name: /text message|SMS/i });
    const email = page.locator('input[name="deliveryMethod"][value="EMAIL"]');
    const emailByRole = page.getByRole("radio", { name: /email/i });

    const smsAvailable =
      (await sms.count().catch(() => 0)) > 0 ||
      (await smsByRole.count().catch(() => 0)) > 0;
    const emailAvailable =
      (await email.count().catch(() => 0)) > 0 ||
      (await emailByRole.count().catch(() => 0)) > 0;

    const selectRadio = async (method: TwoFactorMethod) => {
      logger.action("check", method);
      await this.checkFirst(
        method === "sms"
          ? [
              { name: "deliveryMethod SMS value", locator: sms },
              { name: "SMS radio label", locator: smsByRole },
            ]
          : [
              { name: "deliveryMethod EMAIL value", locator: email },
              { name: "email radio label", locator: emailByRole },
            ],
        `${method} two-factor radio`
      );
    };

    if (preferred === "sms" && smsAvailable) {
      await selectRadio("sms");
      return;
    }

    if (preferred === "email" && emailAvailable) {
      await selectRadio("email");
      return;
    }

    if (smsAvailable) {
      await selectRadio("sms");
      return;
    }

    if (emailAvailable) {
      await selectRadio("email");
      return;
    }

    throw new SelectorNotFoundError("No supported two-factor delivery method was found");
  }

  async execute(context: StepContext): Promise<void> {
    await this.chooseMethod(context, context.credentials.preferredTwoFactorMethod);
    await this.submitContinue(context);
  }
}
