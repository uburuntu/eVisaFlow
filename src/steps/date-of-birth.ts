import type { StepContext } from "../core/internal-types.js";
import { BaseStep } from "./base-step.js";

export class DateOfBirthStep extends BaseStep {
  id = "date-of-birth";

  async detect(page: import("playwright").Page): Promise<boolean> {
    const dateInputs = page.locator(
      'input[name="dob-day"], input[name="dob-month"], input[name="dob-year"]'
    );
    if ((await dateInputs.count().catch(() => 0)) >= 3) {
      return true;
    }

    return this.hasHeading(page, /What is your date of birth\?/i);
  }

  async execute(context: StepContext): Promise<void> {
    const { page, credentials, logger } = context;
    const { day, month, year } = credentials.dateOfBirth;

    logger.action("fill", "date-of-birth");
    await this.fillFirst(
      [
        { name: "dob-day input", locator: page.locator('input[name="dob-day"]') },
        {
          name: "bday-day input",
          locator: page.locator('input[autocomplete="bday-day"]'),
        },
        { name: "Day label", locator: page.getByLabel(/^Day$/i) },
      ],
      String(day),
      "date of birth day"
    );
    await this.fillFirst(
      [
        { name: "dob-month input", locator: page.locator('input[name="dob-month"]') },
        {
          name: "bday-month input",
          locator: page.locator('input[autocomplete="bday-month"]'),
        },
        { name: "Month label", locator: page.getByLabel(/^Month$/i) },
      ],
      String(month),
      "date of birth month"
    );
    await this.fillFirst(
      [
        { name: "dob-year input", locator: page.locator('input[name="dob-year"]') },
        {
          name: "bday-year input",
          locator: page.locator('input[autocomplete="bday-year"]'),
        },
        { name: "Year label", locator: page.getByLabel(/^Year$/i) },
      ],
      String(year),
      "date of birth year"
    );

    await this.submitContinue(context);
  }
}
