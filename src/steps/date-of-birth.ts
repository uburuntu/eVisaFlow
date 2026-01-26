import { BaseStep } from "./base-step.js";
import { HEADINGS } from "../utils/selectors.js";
import type { StepContext } from "../types.js";

export class DateOfBirthStep extends BaseStep {
  id = "date-of-birth";

  async detect(page: import("playwright").Page): Promise<boolean> {
    return this.hasHeading(page, HEADINGS.dateOfBirth);
  }

  async execute(context: StepContext): Promise<void> {
    const { page, credentials, logger } = context;
    const { day, month, year } = credentials.dateOfBirth;

    logger.action("fill", "date-of-birth");
    await page.getByLabel("Day").fill(String(day));
    await page.getByLabel("Month").fill(String(month));
    await page.getByLabel("Year").fill(String(year));

    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForLoadState("domcontentloaded");
  }
}
