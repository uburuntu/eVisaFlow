#!/usr/bin/env node
import { chromium } from "playwright";
import { classifyPage, createPageSnapshot } from "../dist/unstable/testing.js";
import { sanitizeUrl } from "./sanitize-url.js";

const START_URL =
  "https://www.gov.uk/evisa/view-evisa-get-share-code-prove-immigration-status";
const STATUS_URL = "https://view-immigration-status.service.gov.uk/status";
const DOCUMENT_CASES = [
  { label: "Passport", value: "PASSPORT", number: "000000000" },
  { label: "National identity card", value: "ID_CARD", number: "000000000" },
  { label: "BRC or BRP", value: "BRC_CARD", number: "ZZZ000000" },
  {
    label: "UKVI customer number",
    value: "CUSTOMER_REFERENCE",
    number: "KX00000000",
  },
];

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

const exerciseDocumentFlow = async (browser, documentCase, includeLanding) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const label = `${documentCase.label} flow`;

  try {
    if (includeLanding) {
      await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await assertClassified(page, "entry_page", "GOV.UK entry page");
      await page.locator(`a[href^="${STATUS_URL}"]`).first().click();
    } else {
      await page.goto(STATUS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }
    await assertClassified(page, "document_type", `${label}: document type`);

    await page
      .locator(`input[name="documentType"][value="${documentCase.value}"]`)
      .check();
    await continueFlow(page);
    await assertClassified(page, "document_number", `${label}: document number`);

    await page.locator('input[name="documentNumber"]').fill(documentCase.number);
    await continueFlow(page);
    await assertClassified(page, "date_of_birth", `${label}: date of birth`);

    // This impossible date exercises GOV.UK validation without an authentication attempt.
    await page.locator('input[name="dob-day"]').fill("31");
    await page.locator('input[name="dob-month"]').fill("2");
    await page.locator('input[name="dob-year"]').fill("1900");
    await continueFlow(page);
    await assertClassified(page, "auth_error", `${label}: synthetic rejection`);
  } finally {
    await context.close();
  }
};

const run = async () => {
  const browser = await chromium.launch({
    headless: process.env.HEADED !== "1",
  });

  try {
    for (const [index, documentCase] of DOCUMENT_CASES.entries()) {
      await exerciseDocumentFlow(browser, documentCase, index === 0);
    }
  } finally {
    await browser.close();
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
