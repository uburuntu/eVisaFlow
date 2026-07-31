#!/usr/bin/env node
import { chromium } from "playwright";
import { classifyPage, createPageSnapshot } from "../dist/unstable/testing.js";
import { sanitizeUrl } from "./sanitize-url.js";

const START_URL =
  "https://www.gov.uk/evisa/view-evisa-get-share-code-prove-immigration-status";
const STATUS_URL = "https://view-immigration-status.service.gov.uk/status";
const SYNTHETIC_PASSPORT_NUMBER = "000000000";

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

const continueFlow = async (page) => {
  await page.getByRole("button", { name: /^Continue$/i }).click();
};

const run = async () => {
  const browser = await chromium.launch({
    headless: process.env.HEADED !== "1",
  });
  const page = await browser.newPage();

  try {
    await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await assertClassified(page, "entry_page", "GOV.UK entry page");

    await page.locator(`a[href^="${STATUS_URL}"]`).first().click();
    await assertClassified(page, "document_type", "Home Office auth entry");

    await page.locator('input[name="documentType"][value="PASSPORT"]').check();
    await continueFlow(page);
    await assertClassified(page, "document_number", "Document number form");

    await page.locator('input[name="documentNumber"]').fill(SYNTHETIC_PASSPORT_NUMBER);
    await continueFlow(page);
    await assertClassified(page, "date_of_birth", "Date of birth form");

    // This impossible date exercises GOV.UK validation without an authentication attempt.
    await page.locator('input[name="dob-day"]').fill("31");
    await page.locator('input[name="dob-month"]').fill("2");
    await page.locator('input[name="dob-year"]').fill("1900");
    await continueFlow(page);
    await assertClassified(page, "auth_error", "Synthetic input rejection");
  } finally {
    await browser.close();
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
