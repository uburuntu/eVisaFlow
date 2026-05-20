import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import { BrowserLaunchError } from "../errors/index.js";
import type { InternalRunOptions } from "./internal-types.js";

export interface BrowserHandle {
  browser: Browser | null;
  context: BrowserContext;
  page: Page;
}

export const launchBrowser = async (
  options: InternalRunOptions
): Promise<BrowserHandle> => {
  try {
    if (options.userDataDir) {
      const context = await chromium.launchPersistentContext(options.userDataDir, {
        headless: options.headless,
        acceptDownloads: true,
      });
      context.setDefaultTimeout(options.actionTimeoutMs);
      context.setDefaultNavigationTimeout(options.navigationTimeoutMs);
      const page = context.pages()[0] ?? (await context.newPage());
      const browser = context.browser();
      return { browser, context, page };
    }

    const browser = await chromium.launch({
      headless: options.headless,
    });

    const context = await browser.newContext({
      acceptDownloads: true,
    });
    context.setDefaultTimeout(options.actionTimeoutMs);
    context.setDefaultNavigationTimeout(options.navigationTimeoutMs);

    const page = await context.newPage();
    return { browser, context, page };
  } catch (error) {
    throw new BrowserLaunchError(
      "Failed to launch Playwright Chromium. Run `pnpm exec playwright install chromium` and retry.",
      { cause: error }
    );
  }
};
