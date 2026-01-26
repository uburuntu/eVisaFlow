import { BaseStep } from "./base-step.js";
import { DOC_TYPE_LABELS, HEADINGS } from "../utils/selectors.js";
import type { StepContext, AuthMethod } from "../types.js";

const docTypeLabel = (auth: AuthMethod): string => {
  switch (auth.type) {
    case "passport":
      return DOC_TYPE_LABELS.passport;
    case "nationalId":
      return DOC_TYPE_LABELS.nationalId;
    case "brc":
      return DOC_TYPE_LABELS.brc;
    case "ukvi":
      return DOC_TYPE_LABELS.ukvi;
  }
};

export class DocumentTypeStep extends BaseStep {
  id = "document-type";

  async detect(page: import("playwright").Page): Promise<boolean> {
    return this.hasHeading(page, HEADINGS.documentType);
  }

  async execute(context: StepContext): Promise<void> {
    const { page, credentials, logger } = context;
    const label = docTypeLabel(credentials.auth);
    logger.action("check", label);
    await page.getByRole("radio", { name: label }).check();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForLoadState("domcontentloaded");
  }
}
