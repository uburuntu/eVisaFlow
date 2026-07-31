import type { AuthMethod, StepContext } from "../core/internal-types.js";
import { DOC_NUMBER_LABELS } from "../utils/selectors.js";
import { BaseStep, escapeRegExp } from "./base-step.js";

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

  async execute(context: StepContext): Promise<void> {
    const { page, credentials, logger } = context;
    const auth = credentials.auth;
    const label = numberLabel(auth);
    const value = authValue(auth);

    logger.action("fill", label);
    await this.fillFirst(
      [
        {
          name: "documentNumber input",
          locator: page.locator('input[name="documentNumber"], input#documentNumber'),
        },
        {
          name: `${label} label`,
          locator: page.getByLabel(new RegExp(escapeRegExp(label), "i")),
        },
      ],
      value,
      label
    );
    await this.submitContinue(context);
  }
}
