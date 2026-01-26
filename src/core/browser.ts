import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import type { RunOptions } from "../types.js";

export interface BrowserHandle {
  browser: Browser | null;
  context: BrowserContext;
  page: Page;
}

export const launchBrowser = async (
  options: Required<RunOptions>
): Promise<BrowserHandle> => {
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
};
