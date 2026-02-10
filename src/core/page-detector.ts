import type { Step } from "../types.js";

const MAX_RETRIES = 2;

export const detectStep = async (
  steps: Step[],
  page: import("playwright").Page
): Promise<Step | undefined> => {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const urlBefore = page.url();

    for (const step of steps) {
      if (await step.detect(page)) {
        // Verify page didn't navigate during detection
        if (page.url() !== urlBefore) {
          break; // URL changed mid-loop, retry from scratch
        }
        return step;
      }
    }

    // If URL is still the same, detection genuinely found nothing
    if (page.url() === urlBefore) {
      return undefined;
    }
    // Otherwise URL changed during detection — retry
  }

  return undefined;
};
