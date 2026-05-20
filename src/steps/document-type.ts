import type { AuthMethod, StepContext } from "../core/internal-types.js";
import { DOC_TYPE_LABELS } from "../utils/selectors.js";
import { BaseStep } from "./base-step.js";

const DOC_TYPE_VALUES = {
  passport: "PASSPORT",
  nationalId: "ID_CARD",
  brc: "BRC_CARD",
  ukvi: "CUSTOMER_REFERENCE",
} as const satisfies Record<AuthMethod["type"], string>;

const DOC_TYPE_IDS = {
  passport: "passport",
  nationalId: "id-card",
  brc: "brc-card",
  ukvi: "customer-reference",
} as const satisfies Record<AuthMethod["type"], string>;

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
    const hasDocumentTypeRadios = await this.hasLocator(
      page.locator('input[type="radio"][name="documentType"]')
    );
    if (hasDocumentTypeRadios) {
      return true;
    }

    return (
      (await this.hasHeading(page, /identity document/i)) &&
      (await this.hasText(page, /UKVI account/i))
    );
  }

  async execute(context: StepContext): Promise<void> {
    const { page, credentials, logger } = context;
    const auth = credentials.auth;
    const label = docTypeLabel(auth);
    logger.action("check", label);
    await this.checkFirst(
      [
        {
          name: `documentType value ${DOC_TYPE_VALUES[auth.type]}`,
          locator: page.locator(
            `input[name="documentType"][value="${DOC_TYPE_VALUES[auth.type]}"]`
          ),
        },
        {
          name: `documentType id ${DOC_TYPE_IDS[auth.type]}`,
          locator: page.locator(`input#${DOC_TYPE_IDS[auth.type]}`),
        },
        {
          name: `radio label ${label}`,
          locator: page.getByRole("radio", { name: new RegExp(label, "i") }),
        },
      ],
      `${label} radio`
    );
    await this.submitContinue(context);
  }
}
