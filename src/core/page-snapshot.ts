import type { Page } from "playwright";

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
  return page.evaluate((): PageSnapshot => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const isVisible = (element: Element): boolean => {
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }

      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const visibleTexts = (selector: string, limit: number): string[] => {
      const values: string[] = [];
      for (const element of Array.from(document.querySelectorAll(selector))) {
        if (values.length >= limit) {
          break;
        }
        if (!isVisible(element)) {
          continue;
        }
        const text = normalize((element as HTMLElement).innerText);
        if (text) {
          values.push(text);
        }
      }
      return values;
    };

    const controls = Array.from(
      document.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >("main input, main select, main textarea")
    )
      .map((control): ControlSnapshot => {
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
          label: normalize(label),
        };
      })
      .filter((control) => control.type !== "hidden");

    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("main a, a.govuk-button")
    )
      .map((anchor): LinkSnapshot => {
        return {
          text: normalize(anchor.textContent),
          href: anchor.getAttribute("href") ?? undefined,
        };
      })
      .filter((link) => link.text || link.href);

    return {
      url: window.location.href,
      title: normalize(document.title),
      text: normalize(document.body?.innerText),
      headings: visibleTexts("main h1, main h2, h1, h2", 20),
      buttons: visibleTexts(
        'main button, main input[type="submit"], main input[type="button"]',
        20
      ),
      links,
      controls,
      errors: visibleTexts(
        ".govuk-error-summary, .govuk-error-message, [data-module='govuk-error-summary']",
        10
      ),
    };
  });
};
