import type { Page } from "playwright";

export interface StandaloneHtmlOptions {
  inlineImages?: boolean;
  inlineStyles?: boolean;
  removeRuntimeChrome?: boolean;
  assetMaxBytes?: number;
  assetTimeoutMs?: number;
}

export const captureStandaloneHtml = async (
  page: Page,
  options: StandaloneHtmlOptions = {}
): Promise<string> => {
  const {
    inlineImages = true,
    inlineStyles = true,
    removeRuntimeChrome = true,
    assetMaxBytes = 2 * 1024 * 1024,
    assetTimeoutMs = 5_000,
  } = options;

  return page.evaluate(
    async ({
      inlineImages: shouldInlineImages,
      inlineStyles: shouldInlineStyles,
      removeRuntimeChrome: shouldRemoveRuntimeChrome,
      assetMaxBytes: maxAssetBytes,
      assetTimeoutMs: maxAssetFetchMs,
    }) => {
      const clone = document.documentElement.cloneNode(true) as HTMLElement;
      const baseUrl = document.baseURI || window.location.href;
      const sensitiveParams = new Set([
        "session_code",
        "execution",
        "tab_id",
        "code",
        "state",
        "token",
      ]);

      const toAbsoluteUrl = (value: string): string | undefined => {
        const trimmed = value.trim();
        if (
          !trimmed ||
          trimmed.startsWith("#") ||
          trimmed.startsWith("data:") ||
          trimmed.startsWith("blob:") ||
          trimmed.startsWith("javascript:") ||
          trimmed.startsWith("mailto:") ||
          trimmed.startsWith("tel:")
        ) {
          return undefined;
        }

        try {
          return new URL(trimmed, baseUrl).href;
        } catch {
          return undefined;
        }
      };

      const toSafeStandaloneUrl = (value: string): string | undefined => {
        const absolute = toAbsoluteUrl(value);
        if (!absolute) {
          return undefined;
        }

        try {
          const url = new URL(absolute);
          if (
            url.hostname ===
            "user-auth.apply-to-visit-or-stay-in-the-uk.homeoffice.gov.uk"
          ) {
            return undefined;
          }
          for (const param of Array.from(url.searchParams.keys())) {
            if (sensitiveParams.has(param.toLowerCase())) {
              url.searchParams.delete(param);
            }
          }
          url.hash = "";
          return url.href;
        } catch {
          return undefined;
        }
      };

      const bytesToBase64 = (buffer: ArrayBuffer): string => {
        const bytes = new Uint8Array(buffer);
        const chunks: string[] = [];
        for (let index = 0; index < bytes.length; index += 0x8000) {
          chunks.push(String.fromCharCode(...bytes.subarray(index, index + 0x8000)));
        }
        return btoa(chunks.join(""));
      };

      const fetchAsDataUrl = async (url: string): Promise<string | undefined> => {
        const absoluteUrl = toAbsoluteUrl(url);
        if (!absoluteUrl) {
          return undefined;
        }

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), maxAssetFetchMs);
          try {
            const response = await fetch(absoluteUrl, {
              credentials: "include",
              signal: controller.signal,
            });
            if (!response.ok) {
              return undefined;
            }
            const contentLength = Number(response.headers.get("content-length"));
            if (Number.isFinite(contentLength) && contentLength > maxAssetBytes) {
              return undefined;
            }
            const contentType =
              response.headers.get("content-type")?.split(";")[0]?.trim() ||
              "application/octet-stream";
            const buffer = await response.arrayBuffer();
            if (buffer.byteLength > maxAssetBytes) {
              return undefined;
            }
            return `data:${contentType};base64,${bytesToBase64(buffer)}`;
          } finally {
            clearTimeout(timeout);
          }
        } catch {
          return undefined;
        }
      };

      const fetchTextAsset = async (url: string): Promise<string | undefined> => {
        const absoluteUrl = toAbsoluteUrl(url);
        if (!absoluteUrl) {
          return undefined;
        }

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), maxAssetFetchMs);
          try {
            const response = await fetch(absoluteUrl, {
              credentials: "include",
              signal: controller.signal,
            });
            if (!response.ok) {
              return undefined;
            }
            const contentLength = Number(response.headers.get("content-length"));
            if (Number.isFinite(contentLength) && contentLength > maxAssetBytes) {
              return undefined;
            }

            const decoder = new TextDecoder();
            if (!response.body) {
              const buffer = await response.arrayBuffer();
              if (buffer.byteLength > maxAssetBytes) {
                return undefined;
              }
              return decoder.decode(buffer);
            }

            const reader = response.body.getReader();
            const chunks: string[] = [];
            let bytesRead = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              bytesRead += value.byteLength;
              if (bytesRead > maxAssetBytes) {
                await reader.cancel().catch(() => {});
                return undefined;
              }
              chunks.push(decoder.decode(value, { stream: true }));
            }
            chunks.push(decoder.decode());
            return chunks.join("");
          } finally {
            clearTimeout(timeout);
          }
        } catch {
          return undefined;
        }
      };

      const inlineCssUrls = async (
        cssText: string,
        cssBaseUrl: string
      ): Promise<string> => {
        const cssUrlRegex =
          /url\(\s*(["']?)(?!data:|#|about:|javascript:)([^"')]+)\1\s*\)/gi;
        let output = "";
        let lastIndex = 0;

        for (const match of cssText.matchAll(cssUrlRegex)) {
          const matchIndex = match.index ?? 0;
          const rawUrl = match[2]?.trim();
          output += cssText.slice(lastIndex, matchIndex);
          lastIndex = matchIndex + match[0].length;

          if (!rawUrl) {
            output += match[0];
            continue;
          }

          const resolvedUrl = (() => {
            try {
              return new URL(rawUrl, cssBaseUrl).href;
            } catch {
              return undefined;
            }
          })();
          const dataUrl = resolvedUrl ? await fetchAsDataUrl(resolvedUrl) : undefined;
          output += dataUrl ? `url("${dataUrl}")` : match[0];
        }

        return `${output}${cssText.slice(lastIndex)}`;
      };

      const inlineSrcset = async (srcset: string): Promise<string> => {
        if (srcset.includes("data:")) {
          return srcset;
        }
        const candidates = await Promise.all(
          srcset
            .split(",")
            .map((candidate) => candidate.trim())
            .filter(Boolean)
            .map(async (candidate) => {
              const [rawUrl, ...descriptorParts] = candidate.split(/\s+/);
              if (!rawUrl || rawUrl.startsWith("data:")) {
                return candidate;
              }

              const dataUrl = await fetchAsDataUrl(rawUrl);
              if (dataUrl) {
                return [dataUrl, ...descriptorParts].join(" ");
              }

              const absoluteUrl = toAbsoluteUrl(rawUrl);
              return [absoluteUrl ?? rawUrl, ...descriptorParts].join(" ");
            })
        );
        return candidates.join(", ");
      };

      if (shouldRemoveRuntimeChrome) {
        clone
          .querySelectorAll(
            [
              "script",
              "noscript",
              ".govuk-cookie-banner",
              "#timeout-warning-dialog",
              "[data-module='govuk-timeout-warning']",
              "meta[http-equiv='refresh']",
            ].join(",")
          )
          .forEach((element) => {
            element.remove();
          });
      } else {
        clone.querySelectorAll("script[src]").forEach((element) => {
          element.remove();
        });
      }

      clone.querySelectorAll("link[rel='manifest']").forEach((element) => {
        element.remove();
      });

      clone.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
        const name = (input.getAttribute("name") ?? "").toLowerCase();
        const id = (input.getAttribute("id") ?? "").toLowerCase();
        const sensitive =
          input.type === "hidden" ||
          /csrf|token|session|execution|tab_id|session_code/.test(name) ||
          /csrf|token|session|execution|tab_id|session_code/.test(id);
        if (sensitive) {
          input.remove();
        }
      });

      if (shouldInlineStyles) {
        const stylesheetLinks = Array.from(
          clone.querySelectorAll<HTMLLinkElement>("link[rel~='stylesheet'][href]")
        );
        for (const link of stylesheetLinks) {
          const href = link.getAttribute("href");
          const absoluteUrl = href ? toAbsoluteUrl(href) : undefined;
          if (!absoluteUrl) {
            continue;
          }
          try {
            const css = await fetchTextAsset(absoluteUrl);
            if (css === undefined) {
              continue;
            }
            const inlinedCss = await inlineCssUrls(css, absoluteUrl);
            const style = document.createElement("style");
            style.setAttribute("data-inlined-from", absoluteUrl);
            style.textContent = inlinedCss.replace(/<\/style/gi, "<\\/style");
            link.replaceWith(style);
          } catch {
            link.href = absoluteUrl;
          }
        }
      }

      if (shouldInlineImages) {
        const imageElements = Array.from(
          clone.querySelectorAll<HTMLImageElement>("img[src]")
        );
        for (const image of imageElements) {
          const src = image.getAttribute("src");
          if (!src || src.startsWith("data:")) {
            continue;
          }
          const dataUrl = await fetchAsDataUrl(src);
          if (dataUrl) {
            image.setAttribute("src", dataUrl);
          } else {
            const absoluteUrl = toAbsoluteUrl(src);
            if (absoluteUrl) {
              image.setAttribute("src", absoluteUrl);
            }
          }
        }

        const srcsetElements = Array.from(
          clone.querySelectorAll<HTMLImageElement | HTMLSourceElement>(
            "img[srcset], source[srcset]"
          )
        );
        for (const element of srcsetElements) {
          const srcset = element.getAttribute("srcset");
          if (srcset) {
            element.setAttribute("srcset", await inlineSrcset(srcset));
          }
        }

        const posterElements = Array.from(
          clone.querySelectorAll<HTMLVideoElement>("video[poster]")
        );
        for (const video of posterElements) {
          const poster = video.getAttribute("poster");
          if (!poster || poster.startsWith("data:")) {
            continue;
          }
          const dataUrl = await fetchAsDataUrl(poster);
          const absoluteUrl = dataUrl ?? toAbsoluteUrl(poster);
          if (absoluteUrl) {
            video.setAttribute("poster", absoluteUrl);
          }
        }

        const iconLinks = Array.from(
          clone.querySelectorAll<HTMLLinkElement>(
            [
              "link[rel~='icon'][href]",
              "link[rel~='apple-touch-icon'][href]",
              "link[rel~='mask-icon'][href]",
              "link[rel~='preload'][as='image'][href]",
            ].join(",")
          )
        );
        for (const link of iconLinks) {
          const href = link.getAttribute("href");
          if (!href || href.startsWith("data:")) {
            continue;
          }
          const dataUrl = await fetchAsDataUrl(href);
          if (dataUrl) {
            link.setAttribute("href", dataUrl);
          } else {
            const absoluteUrl = toAbsoluteUrl(href);
            if (absoluteUrl) {
              link.setAttribute("href", absoluteUrl);
            }
          }
        }
      }

      if (shouldInlineStyles) {
        const styledElements = Array.from(clone.querySelectorAll<HTMLElement>("[style]"));
        for (const element of styledElements) {
          const style = element.getAttribute("style");
          if (style) {
            element.setAttribute("style", await inlineCssUrls(style, baseUrl));
          }
        }
      }

      clone.querySelectorAll<HTMLElement>("[href]").forEach((element) => {
        const href = element.getAttribute("href");
        const safeUrl = href ? toSafeStandaloneUrl(href) : undefined;
        if (safeUrl) {
          element.setAttribute("href", safeUrl);
        } else {
          element.removeAttribute("href");
        }
      });
      clone.querySelectorAll<HTMLElement>("[action]").forEach((element) => {
        element.removeAttribute("action");
      });

      const head = clone.querySelector("head");
      if (head) {
        const generatedAt = document.createElement("meta");
        generatedAt.setAttribute("name", "evisa-flow-generated-at");
        generatedAt.setAttribute("content", new Date().toISOString());
        head.append(generatedAt);
      }

      return `<!DOCTYPE html>\n${clone.outerHTML}`;
    },
    { inlineImages, inlineStyles, removeRuntimeChrome, assetMaxBytes, assetTimeoutMs }
  );
};
