#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const START_URL =
  "https://www.gov.uk/evisa/view-evisa-get-share-code-prove-immigration-status";
const STATUS_URL = "https://view-immigration-status.service.gov.uk/status";
const OUTPUT_DIR = process.env.SNAPSHOT_DIR ?? "snapshots";

const sanitizeHtml = (html) =>
  html
    .replace(/(session_code=)[^&"']+/g, "$1REDACTED")
    .replace(/(execution=)[^&"']+/g, "$1REDACTED")
    .replace(/(tab_id=)[^&"']+/g, "$1REDACTED")
    .replace(/(state=)[^&"']+/g, "$1REDACTED")
    .replace(/(nonce=)[^&"']+/g, "$1REDACTED")
    .replace(/(name="csrfToken" id="csrfToken" value=")[^"]*(")/g, "$1REDACTED$2")
    .replace(/(name="_csrf" value=")[^"]*(")/g, "$1REDACTED$2");

const capture = async (page, label, url) => {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});

  const htmlPath = join(OUTPUT_DIR, `${label}.html`);
  const screenshotPath = join(OUTPUT_DIR, `${label}.png`);
  const heading = await page
    .locator("h1")
    .first()
    .innerText()
    .catch(() => "");

  await writeFile(htmlPath, sanitizeHtml(await page.content()), "utf-8");
  await page.screenshot({ path: screenshotPath, fullPage: true });

  process.stdout.write(
    `${label}: ${page.url()}${heading ? ` - ${heading.trim()}` : ""}\n`
  );
};

const run = async () => {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: process.env.HEADED !== "1",
  });
  const page = await browser.newPage();

  try {
    await capture(page, "govuk-entry-page", START_URL);
    await capture(page, "homeoffice-auth-document-type", STATUS_URL);
  } finally {
    await browser.close();
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
