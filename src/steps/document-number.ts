import { BaseStep } from "./base-step.js";
import { DOC_NUMBER_LABELS, HEADINGS } from "../utils/selectors.js";
import type { StepContext, AuthMethod } from "../types.js";

const numberLabel = (auth: AuthMethod): string => {
  switch (auth.type) {
    case "passport":
      return DOC_NUMBER_LABELS.passport;
    case "nationalId":
      return DOC_NUMBER_LABELS.nationalId;
    case "brc":
      return DOC_NUMBER_LABELS.brc;
    case "ukvi":
      return DOC_NUMBER_LABELS.ukvi;
  }
};

const pageHeading = (auth: AuthMethod): string => {
  switch (auth.type) {
    case "passport":
      return HEADINGS.passportNumber;
    case "nationalId":
      return HEADINGS.nationalIdNumber;
    case "brc":
      return HEADINGS.brcNumber;
    case "ukvi":
      return HEADINGS.ukviNumber;
  }
};

const authValue = (auth: AuthMethod): string => {
  switch (auth.type) {
    case "passport":
      return auth.passportNumber;
    case "nationalId":
      return auth.idNumber;
    case "brc":
      return auth.cardNumber;
    case "ukvi":
      return auth.customerNumber;
  }
};

export class DocumentNumberStep extends BaseStep {
  id = "document-number";

  async detect(page: import("playwright").Page): Promise<boolean> {
    const headings = [
      HEADINGS.passportNumber,
      HEADINGS.nationalIdNumber,
      HEADINGS.brcNumber,
      HEADINGS.ukviNumber,
    ];

    for (const heading of headings) {
      if (await this.hasHeading(page, heading)) {
        return true;
      }
    }
    return false;
  }

  async execute(context: StepContext): Promise<void> {
    const { page, credentials, logger } = context;
    const auth = credentials.auth;
    const heading = pageHeading(auth);
    const label = numberLabel(auth);
    const value = authValue(auth);

    logger.action("fill", label);
    await page.getByRole("heading", { name: heading }).waitFor();
    await page.getByLabel(label).fill(value);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForLoadState("domcontentloaded");
  }
}
