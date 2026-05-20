#!/usr/bin/env node
import { chromium } from "playwright";
import { DocumentTypeStep, EntryPageStep } from "../dist/unstable/testing.js";

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

const assertDetected = async (page, step, label) => {
  if (await step.detect(page)) {
    process.stdout.write(`${label}: detected ${step.id} at ${page.url()}\n`);
    return;
  }

  throw new Error(
    `${label}: ${step.id} was not detected at ${page.url()} (heading: ${await firstHeading(page)})`
  );
};

const run = async () => {
  const browser = await chromium.launch({
    headless: process.env.HEADED !== "1",
  });
  const page = await browser.newPage();

  try {
    await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await assertDetected(page, new EntryPageStep(), "GOV.UK entry page");

    await page.goto(STATUS_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await assertDetected(page, new DocumentTypeStep(), "Home Office auth entry");
  } finally {
    await browser.close();
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
