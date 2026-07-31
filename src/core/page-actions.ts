import type { Locator, Page } from "playwright";
import { SelectorNotFoundError } from "../errors/index.js";

export interface LocatorCandidate {
  name: string;
  locator: Locator;
}

export const normalizeText = (value: string | null | undefined): string =>
  (value ?? "").replace(/\s+/g, " ").trim();

export const hasVisible = async (locator: Locator, limit = 5): Promise<boolean> => {
  const count = Math.min(await locator.count().catch(() => 0), limit);
  for (let index = 0; index < count; index += 1) {
    if (
      await locator
        .nth(index)
        .isVisible()
        .catch(() => false)
    ) {
      return true;
    }
  }
  return false;
};

export const findFirst = async (
  candidates: LocatorCandidate[],
  purpose: string,
  timeout = 5_000
): Promise<Locator> => {
  const deadline = Date.now() + timeout;

  while (Date.now() <= deadline) {
    for (const candidate of candidates) {
      const count = await candidate.locator.count().catch(() => 0);
      if (count > 0) {
        return candidate.locator.first();
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
  }

  throw new SelectorNotFoundError(
    `Could not find ${purpose}. Tried: ${candidates
      .map((candidate) => candidate.name)
      .join(", ")}`
  );
};

export const fillFirst = async (
  candidates: LocatorCandidate[],
  value: string,
  purpose: string,
  timeout = 5_000
): Promise<void> => {
  const locator = await findFirst(candidates, purpose, timeout);
  await locator.waitFor({ state: "visible", timeout });
  await locator.fill(value);
};

export const checkFirst = async (
  candidates: LocatorCandidate[],
  purpose: string,
  timeout = 5_000
): Promise<void> => {
  const locator = await findFirst(candidates, purpose, timeout);
  await locator.check({ timeout });
};

export const clickFirstAndWait = async (
  page: Page,
  candidates: LocatorCandidate[],
  purpose: string,
  timeout = 30_000
): Promise<void> => {
  const locator = await findFirst(candidates, purpose, timeout);
  await locator.click({ timeout });
  await page
    .locator("body")
    .waitFor({ state: "attached", timeout: Math.min(timeout, 5_000) })
    .catch(() => {});
};

export const readSummaryList = async (page: Page): Promise<Record<string, string>> => {
  const rows = await page.locator(".govuk-summary-list__row").evaluateAll(
    (elements): Array<[string, string]> =>
      elements
        .map((element) => {
          const key = element.querySelector(".govuk-summary-list__key, dt")?.textContent;
          const value = element.querySelector(
            ".govuk-summary-list__value, dd"
          )?.textContent;
          const normalizedKey = (key ?? "").replace(/\s+/g, " ").trim();
          const normalizedValue = (value ?? "").replace(/\s+/g, " ").trim();
          return [normalizedKey, normalizedValue] as [string, string];
        })
        .filter(([key, value]) => key.length > 0 && value.length > 0)
  );

  return Object.fromEntries(rows);
};
