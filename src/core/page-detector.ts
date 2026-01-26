import type { Step } from "../types.js";

export const detectStep = async (
  steps: Step[],
  page: import("playwright").Page
): Promise<Step | undefined> => {
  for (const step of steps) {
    if (await step.detect(page)) {
      return step;
    }
  }
  return undefined;
};
