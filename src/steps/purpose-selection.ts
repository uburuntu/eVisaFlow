import { BaseStep } from "./base-step.js";
import { HEADINGS, PURPOSE_LABELS } from "../utils/selectors.js";
import type { StepContext } from "../types.js";

export class PurposeSelectionStep extends BaseStep {
  id = "purpose-selection";

  private static readonly PURPOSE_IDS = {
    right_to_work: "work",
    right_to_rent: "rent",
    immigration_status_other: "somethingElse",
  } as const;

  private static escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  async detect(page: import("playwright").Page): Promise<boolean> {
    return this.hasHeading(page, HEADINGS.purpose);
  }

  async execute(context: StepContext): Promise<void> {
    const { page, logger, purpose } = context;
    const label = PURPOSE_LABELS[purpose];
    logger.action("check", label);

    const labelRegex = new RegExp(
      `^${PurposeSelectionStep.escapeRegExp(label)}\\s*$`
    );
    const byRole = page.getByRole("radio", { name: labelRegex });
    const byId = page.locator(
      `input[name="listedPurpose"]#${PurposeSelectionStep.PURPOSE_IDS[purpose]}`
    );
    const byValue = page.locator(
      `input[name="listedPurpose"][value^="${label}"]`
    );

    if ((await byRole.count()) > 0) {
      await byRole.first().check();
    } else if ((await byId.count()) > 0) {
      await byId.first().check();
    } else {
      await byValue.first().check();
    }
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForLoadState("domcontentloaded");
  }
}
