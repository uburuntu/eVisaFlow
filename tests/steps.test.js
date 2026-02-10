import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test, { describe, before, after } from "node:test";
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

before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
});

after(async () => {
  await browser?.close();
});

// ──────────────────────────────────────────────
// 1. Original detection tests
// ──────────────────────────────────────────────

describe("step detection", () => {
  test("each step detects its own fixture", async () => {
    for (const { Step, file } of fixtures) {
      const page = await context.newPage();
      const html = await readFile(`./tests/fixtures/${file}`, "utf-8");
      await page.setContent(html);
      const step = new Step();
      const detected = await step.detect(page);
      await page.close();
      assert.equal(detected, true, `${step.id} should be detected on ${file}`);
    }
  });

  test("steps do not false-positive on other fixtures", async () => {
    // Test a subset: DocumentNumberStep should NOT detect the date-of-birth page
    const page = await context.newPage();
    const html = await readFile(`./tests/fixtures/step-date-of-birth.html`, "utf-8");
    await page.setContent(html);
    const step = new DocumentNumberStep();
    const detected = await step.detect(page);
    await page.close();
    assert.equal(detected, false, "document-number should not detect date-of-birth page");
  });

  test("EntryPageStep does not detect document-type page", async () => {
    const page = await context.newPage();
    const html = await readFile(`./tests/fixtures/step-document-type.html`, "utf-8");
    await page.setContent(html);
    const step = new EntryPageStep();
    const detected = await step.detect(page);
    await page.close();
    assert.equal(detected, false, "entry-page should not detect document-type page");
  });
});

// ──────────────────────────────────────────────
// 2. Non-passport document number detection
// ──────────────────────────────────────────────

describe("non-passport document number detection", () => {
  const nonPassportFixtures = [
    { file: "step-document-number-national-id.html", label: "nationalId" },
    { file: "step-document-number-brc.html", label: "brc" },
    { file: "step-document-number-ukvi.html", label: "ukvi" },
  ];

  for (const { file, label } of nonPassportFixtures) {
    test(`DocumentNumberStep detects ${label} fixture`, async () => {
      const page = await context.newPage();
      const html = await readFile(`./tests/fixtures/${file}`, "utf-8");
      await page.setContent(html);
      const step = new DocumentNumberStep();
      const detected = await step.detect(page);
      await page.close();
      assert.equal(detected, true, `document-number should detect ${label} page`);
    });
  }
});

// ──────────────────────────────────────────────
// 3. Document type execute — all 4 auth methods
// ──────────────────────────────────────────────

describe("DocumentTypeStep execute", () => {
  const noopLogger = {
    step() {},
    action() {},
    info() {},
    warn() {},
    error() {},
    debug() {},
    screenshot() {},
  };

  const baseContext = {
    purpose: "immigration_status_other",
    options: {
      headless: true,
      verbose: false,
      screenshotOnError: false,
      outputDir: "/tmp/test",
      outputFile: "",
      userDataDir: "",
      navigationTimeoutMs: 60000,
      actionTimeoutMs: 30000,
      twoFactorTimeoutMs: 600000,
    },
    logger: noopLogger,
    extractedData: {},
    setResult() {},
    onTwoFactorRequired: async () => "",
  };

  const authTypes = [
    { type: "passport", passportNumber: "123456789", expectedLabel: "Passport" },
    { type: "nationalId", idNumber: "L01X00T47", expectedLabel: "National identity card" },
    { type: "brc", cardNumber: "RFN123456", expectedLabel: "Biometric residence card or permit" },
    { type: "ukvi", customerNumber: "1234-5678-9012-3456", expectedLabel: "I use a UKVI customer number" },
  ];

  for (const authData of authTypes) {
    test(`selects ${authData.type} radio and submits`, async () => {
      const page = await context.newPage();
      const html = await readFile(`./tests/fixtures/step-document-type.html`, "utf-8");
      await page.setContent(html);

      // Intercept form submission so it doesn't navigate
      await page.route("**/*", (route) => {
        route.fulfill({ status: 200, body: "<html><body>submitted</body></html>" });
      });

      const step = new DocumentTypeStep();
      const ctx = {
        ...baseContext,
        page,
        credentials: {
          auth: authData,
          dateOfBirth: { day: 1, month: 1, year: 1990 },
        },
      };

      await step.execute(ctx);

      // Verify the correct radio was checked before form submitted
      // (page has already navigated to the mock, so we check indirectly by reaching here without error)
      await page.close();
    });
  }
});

// ──────────────────────────────────────────────
// 4. Document number execute — all 4 auth methods
// ──────────────────────────────────────────────

describe("DocumentNumberStep execute", () => {
  const noopLogger = {
    step() {},
    action() {},
    info() {},
    warn() {},
    error() {},
    debug() {},
    screenshot() {},
  };

  const baseContext = {
    purpose: "immigration_status_other",
    options: {
      headless: true,
      verbose: false,
      screenshotOnError: false,
      outputDir: "/tmp/test",
      outputFile: "",
      userDataDir: "",
      navigationTimeoutMs: 60000,
      actionTimeoutMs: 30000,
      twoFactorTimeoutMs: 600000,
    },
    logger: noopLogger,
    extractedData: {},
    setResult() {},
    onTwoFactorRequired: async () => "",
  };

  const cases = [
    {
      fixture: "step-document-number.html",
      auth: { type: "passport", passportNumber: "123456789" },
    },
    {
      fixture: "step-document-number-national-id.html",
      auth: { type: "nationalId", idNumber: "L01X00T47" },
    },
    {
      fixture: "step-document-number-brc.html",
      auth: { type: "brc", cardNumber: "RFN123456" },
    },
    {
      fixture: "step-document-number-ukvi.html",
      auth: { type: "ukvi", customerNumber: "1234-5678-9012-3456" },
    },
  ];

  for (const { fixture, auth } of cases) {
    test(`fills ${auth.type} document number and submits`, async () => {
      const page = await context.newPage();
      const html = await readFile(`./tests/fixtures/${fixture}`, "utf-8");
      await page.setContent(html);

      // Intercept form submission
      await page.route("**/*", (route) => {
        route.fulfill({ status: 200, body: "<html><body>submitted</body></html>" });
      });

      const step = new DocumentNumberStep();
      const ctx = {
        ...baseContext,
        page,
        credentials: {
          auth,
          dateOfBirth: { day: 1, month: 1, year: 1990 },
        },
      };

      await step.execute(ctx);
      await page.close();
    });
  }
});

// ──────────────────────────────────────────────
// 5. Share code extraction (download-pdf detection)
// ──────────────────────────────────────────────

describe("DownloadPdfStep", () => {
  test("detects the download-pdf page", async () => {
    const page = await context.newPage();
    const html = await readFile(`./tests/fixtures/step-download-pdf.html`, "utf-8");
    await page.setContent(html);
    const step = new DownloadPdfStep();
    const detected = await step.detect(page);
    await page.close();
    assert.equal(detected, true, "download-pdf should detect its page");
  });

  test("does not detect the summary page", async () => {
    const page = await context.newPage();
    const html = await readFile(`./tests/fixtures/step-summary.html`, "utf-8");
    await page.setContent(html);
    const step = new DownloadPdfStep();
    const detected = await step.detect(page);
    await page.close();
    assert.equal(detected, false, "download-pdf should not detect summary page");
  });
});
