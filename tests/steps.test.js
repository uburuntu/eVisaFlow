import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import {
  EntryPageStep,
  DocumentTypeStep,
  DocumentNumberStep,
  DateOfBirthStep,
  TwoFactorMethodStep,
  TwoFactorCodeStep,
  ProveStatusStep,
  ConfirmationStep,
  PurposeSelectionStep,
  SummaryStep,
  DownloadPdfStep,
} from "../dist/index.js";

const fixtures = [
  { Step: EntryPageStep, file: "step-entry-page.html" },
  { Step: DocumentTypeStep, file: "step-document-type.html" },
  { Step: DocumentNumberStep, file: "step-document-number.html" },
  { Step: DateOfBirthStep, file: "step-date-of-birth.html" },
  { Step: TwoFactorMethodStep, file: "step-two-factor-method.html" },
  { Step: TwoFactorCodeStep, file: "step-two-factor-code.html" },
  { Step: ProveStatusStep, file: "step-prove-status.html" },
  { Step: ConfirmationStep, file: "step-confirmation.html" },
  { Step: PurposeSelectionStep, file: "step-purpose-selection.html" },
  { Step: SummaryStep, file: "step-summary.html" },
  { Step: DownloadPdfStep, file: "step-download-pdf.html" },
];

let browser;
let context;

test.before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
});

test.after(async () => {
  await browser?.close();
});

test("step detection via fixtures", async () => {
  for (const { Step, file } of fixtures) {
    const page = await context.newPage();
    const html = await readFile(`./tests/fixtures/${file}`, "utf-8");
    await page.setContent(html);
    const step = new Step();
    const detected = await step.detect(page);
    await page.close();
    assert.equal(detected, true, `${step.id} should be detected`);
  }
});
