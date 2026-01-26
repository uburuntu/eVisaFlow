import { BaseStep } from "./base-step.js";
import { HEADINGS } from "../utils/selectors.js";
import type { StepContext, TwoFactorMethod } from "../types.js";

export class TwoFactorMethodStep extends BaseStep {
  id = "two-factor-method";

  async detect(page: import("playwright").Page): Promise<boolean> {
    return this.hasHeading(page, HEADINGS.twoFactorMethod);
  }

  private async chooseMethod(
    context: StepContext,
    preferred?: TwoFactorMethod
  ): Promise<void> {
    const { page, logger } = context;
    const sms = page.getByRole("radio", { name: /text message/i });
    const email = page.getByRole("radio", { name: /email/i });

    const smsAvailable = (await sms.count()) > 0;
    const emailAvailable = (await email.count()) > 0;

    const selectRadio = async (method: TwoFactorMethod) => {
      const radio = method === "sms" ? sms : email;
      logger.action("check", method);
      await radio.check();
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
  }

  async execute(context: StepContext): Promise<void> {
    await this.chooseMethod(context, context.credentials.preferredTwoFactorMethod);
    await context.page.getByRole("button", { name: "Continue" }).click();
    await context.page.waitForLoadState("domcontentloaded");
  }
}
