import type { StepContext } from "../core/internal-types.js";
import { PURPOSE_LABELS } from "../utils/selectors.js";
import { BaseStep, escapeRegExp } from "./base-step.js";

export class PurposeSelectionStep extends BaseStep {
  id = "purpose-selection";

  private static readonly PURPOSE_IDS = {
    right_to_work: "work",
    right_to_rent: "rent",
    immigration_status_other: "somethingElse",
  } as const;

  async execute(context: StepContext): Promise<void> {
    const { page, logger, purpose } = context;
    const label = PURPOSE_LABELS[purpose];
    logger.action("check", label);

    const labelRegex = new RegExp(`^${escapeRegExp(label)}\\s*$`, "i");

    await this.checkFirst(
      [
        {
          name: `listedPurpose id ${PurposeSelectionStep.PURPOSE_IDS[purpose]}`,
          locator: page.locator(
            `input[name="listedPurpose"]#${PurposeSelectionStep.PURPOSE_IDS[purpose]}`
          ),
        },
        {
          name: `listedPurpose value ${label}`,
          locator: page.locator(
            `input[name="listedPurpose"][value^="${label.replace(/"/g, '\\"')}"]`
          ),
        },
        {
          name: `radio label ${label}`,
          locator: page.getByRole("radio", { name: labelRegex }),
        },
      ],
      `${label} radio`
    );
    await this.submitContinue(context);
  }
}
