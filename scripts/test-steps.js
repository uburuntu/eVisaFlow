#!/usr/bin/env node
import { readFile } from "node:fs/promises";
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

const testStep = async (page, step, htmlFile) => {
  const html = await readFile(`./tests/fixtures/${htmlFile}`, "utf-8");
  await page.setContent(html);
  const detected = await step.detect(page);
  const status = detected ? "PASS" : "FAIL";
  console.log(`  ${status} ${step.id}: ${detected ? "detected" : "not detected"}`);
  return detected;
};

const runTests = async () => {
  console.log("Testing step detection with sanitized fixtures...\n");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const results = [
    await testStep(page, new EntryPageStep(), "step-entry-page.html"),
    await testStep(page, new DocumentTypeStep(), "step-document-type.html"),
    await testStep(page, new DocumentNumberStep(), "step-document-number.html"),
    await testStep(page, new DateOfBirthStep(), "step-date-of-birth.html"),
    await testStep(page, new TwoFactorMethodStep(), "step-two-factor-method.html"),
    await testStep(page, new TwoFactorCodeStep(), "step-two-factor-code.html"),
    await testStep(page, new ProveStatusStep(), "step-prove-status.html"),
    await testStep(page, new ConfirmationStep(), "step-confirmation.html"),
    await testStep(page, new PurposeSelectionStep(), "step-purpose-selection.html"),
    await testStep(page, new SummaryStep(), "step-summary.html"),
    await testStep(page, new DownloadPdfStep(), "step-download-pdf.html"),
  ];

  await browser.close();

  const passed = results.filter(Boolean).length;
  const total = results.length;
  console.log(`\nResults: ${passed}/${total} tests passed`);
  process.exit(passed === total ? 0 : 1);
};

runTests().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
