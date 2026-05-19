import type { Locator, Page } from "playwright";

const normalizeText = (value: string | null | undefined): string =>
  (value ?? "").replace(/\s+/g, " ").trim();

const visibleTexts = async (locator: Locator, limit = 20): Promise<string[]> => {
  const count = Math.min(await locator.count().catch(() => 0), limit);
  const values: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible().catch(() => false))) {
      continue;
    }

    const text = normalizeText(await item.innerText().catch(() => ""));
    if (text) {
      values.push(text);
    }
  }

  return values;
};

export interface ControlSnapshot {
  tag: string;
  type?: string;
  id?: string;
  name?: string;
  value?: string;
  autocomplete?: string;
  label?: string;
}

export interface LinkSnapshot {
  text: string;
  href?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  headings: string[];
  buttons: string[];
  links: LinkSnapshot[];
  controls: ControlSnapshot[];
  errors: string[];
}

export interface SanitizedDiagnosticSnapshot {
  url?: string;
  title: string;
  headings: string[];
  buttons: string[];
  links: LinkSnapshot[];
  controls: Array<Pick<ControlSnapshot, "tag" | "type" | "id" | "name" | "autocomplete">>;
  errors: string[];
}

const sanitizeHref = (href: string | undefined): string | undefined => {
  const value = href?.trim();
  if (!value) {
    return undefined;
  }

  return value.split(/[?#]/, 1)[0] || undefined;
};

export const createSanitizedDiagnosticSnapshot = (
  snapshot: PageSnapshot
): SanitizedDiagnosticSnapshot => ({
  url: sanitizeHref(snapshot.url),
  title: snapshot.title,
  headings: snapshot.headings,
  buttons: snapshot.buttons,
  links: snapshot.links.map((link) => ({
    text: link.text,
    href: sanitizeHref(link.href),
  })),
  controls: snapshot.controls.map((control) => ({
    tag: control.tag,
    type: control.type,
    id: control.id,
    name: control.name,
    autocomplete: control.autocomplete,
  })),
  errors: snapshot.errors,
});

export const createPageSnapshot = async (page: Page): Promise<PageSnapshot> => {
  const controls = await page
    .locator("main input, main select, main textarea")
    .evaluateAll((elements): ControlSnapshot[] =>
      elements
        .map((element) => {
          const control = element as HTMLInputElement;
          const id = control.getAttribute("id") ?? undefined;
          const label =
            id === undefined
              ? undefined
              : (document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent ??
                undefined);
          return {
            tag: control.tagName.toLowerCase(),
            type: control.getAttribute("type") ?? undefined,
            id,
            name: control.getAttribute("name") ?? undefined,
            value: control.getAttribute("value") ?? undefined,
            autocomplete: control.getAttribute("autocomplete") ?? undefined,
            label: label?.replace(/\s+/g, " ").trim(),
          };
        })
        .filter((control) => control.type !== "hidden")
    );

  const links = await page
    .locator("main a, a.govuk-button")
    .evaluateAll((elements): LinkSnapshot[] =>
      elements
        .map((element) => {
          const anchor = element as HTMLAnchorElement;
          return {
            text: (anchor.textContent ?? "").replace(/\s+/g, " ").trim(),
            href: anchor.getAttribute("href") ?? undefined,
          };
        })
        .filter((link) => link.text || link.href)
    );

  const title = await page.title().catch(() => "");
  const text = normalizeText(
    await page
      .locator("body")
      .innerText()
      .catch(() => "")
  );

  return {
    url: page.url(),
    title: normalizeText(title),
    text,
    headings: await visibleTexts(page.locator("main h1, main h2, h1, h2"), 20),
    buttons: await visibleTexts(
      page.locator('main button, main input[type="submit"], main input[type="button"]'),
      20
    ),
    links,
    controls,
    errors: await visibleTexts(
      page.locator(
        ".govuk-error-summary, .govuk-error-message, [data-module='govuk-error-summary']"
      ),
      10
    ),
  };
};
