#!/usr/bin/env node
import { chromium } from "playwright";
import { classifyPage, createPageSnapshot } from "../dist/unstable/testing.js";
import { sanitizeUrl } from "./sanitize-url.js";

const START_URL =
  "https://www.gov.uk/evisa/view-evisa-get-share-code-prove-immigration-status";
const STATUS_URL = "https://view-immigration-status.service.gov.uk/status";

const firstHeading = async (page) =>
  (
    await page
      .locator("h1")
      .first()
      .innerText()
      .catch(() => "")
  ).trim();

const assertClassified = async (page, expectedKind, label) => {
  const classification = classifyPage(await createPageSnapshot(page));
  if (classification.kind === expectedKind) {
    process.stdout.write(
      `${label}: classified ${expectedKind} at ${sanitizeUrl(page.url())}\n`
    );
    return;
  }

  throw new Error(
    `${label}: expected ${expectedKind}, got ${classification.kind} at ${sanitizeUrl(page.url())} (heading: ${await firstHeading(page)}, evidence: ${classification.evidence.join(", ")})`
  );
};

const run = async () => {
  const browser = await chromium.launch({
    headless: process.env.HEADED !== "1",
  });
  const page = await browser.newPage();

  try {
    await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await assertClassified(page, "entry_page", "GOV.UK entry page");

    await page.goto(STATUS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await assertClassified(page, "document_type", "Home Office auth entry");
  } finally {
    await browser.close();
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
