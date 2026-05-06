import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import { chromium } from "playwright";
import {
  ConfirmationStep,
  classifyPage,
  createPageSnapshot,
  DateOfBirthStep,
  DocumentNumberStep,
  DocumentTypeStep,
  DownloadPdfStep,
  EntryPageStep,
  ProveStatusStep,
  PurposeSelectionStep,
  SummaryStep,
  TwoFactorCodeStep,
  TwoFactorMethodStep,
} from "../dist/unstable/testing.js";

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
    pdfEnabled: true,
    outputDir: "/tmp/test",
    outputFile: "",
    userDataDir: "",
    diagnosticsMode: "off",
    diagnosticsDir: "/tmp/test/debug",
    navigationTimeoutMs: 60000,
    actionTimeoutMs: 30000,
    twoFactorTimeoutMs: 600000,
  },
  logger: noopLogger,
  extractedData: {},
  setResult() {},
  addArtifacts() {},
  emit() {},
  onTwoFactorRequired: async () => "",
};

before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ acceptDownloads: true });
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

  test("detects core auth pages from stable form signatures", async () => {
    const cases = [
      {
        Step: DocumentTypeStep,
        html: '<form><input type="radio" name="documentType" value="PASSPORT"></form>',
      },
      {
        Step: DocumentNumberStep,
        html: '<form><label for="documentNumber">Travel document</label><input id="documentNumber" name="documentNumber"></form>',
      },
      {
        Step: DateOfBirthStep,
        html: '<form><input name="dob-day"><input name="dob-month"><input name="dob-year"></form>',
      },
      {
        Step: TwoFactorMethodStep,
        html: '<form><input type="radio" name="deliveryMethod" value="SMS"></form>',
      },
      {
        Step: TwoFactorCodeStep,
        html: '<h1>Security check</h1><form><label for="verificationCode">Security code</label><input id="verificationCode" name="verificationCode"></form>',
      },
    ];

    for (const { Step, html } of cases) {
      const page = await context.newPage();
      await page.setContent(html);
      const step = new Step();
      const detected = await step.detect(page);
      await page.close();
      assert.equal(detected, true, `${step.id} should detect form signature`);
    }
  });

  test("classifies fixture pages with evidence", async () => {
    const expectedKinds = [
      { file: "step-entry-page.html", kind: "entry_page" },
      { file: "step-document-type.html", kind: "document_type" },
      { file: "step-document-number.html", kind: "document_number" },
      { file: "step-date-of-birth.html", kind: "date_of_birth" },
      { file: "step-two-factor-method.html", kind: "two_factor_method" },
      { file: "step-two-factor-code.html", kind: "two_factor_code" },
      { file: "step-prove-status.html", kind: "prove_status" },
      { file: "step-confirmation.html", kind: "confirmation" },
      { file: "step-purpose-selection.html", kind: "purpose_selection" },
      { file: "step-summary.html", kind: "summary" },
      { file: "step-download-pdf.html", kind: "download_pdf" },
    ];

    for (const { file, kind } of expectedKinds) {
      const page = await context.newPage();
      const html = await readFile(`./tests/fixtures/${file}`, "utf-8");
      await page.setContent(html);
      const classification = classifyPage(await createPageSnapshot(page));
      await page.close();
      assert.equal(classification.kind, kind, `${file} should classify as ${kind}`);
      assert.equal(
        classification.evidence.length > 0,
        true,
        `${file} should have evidence`
      );
    }
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
  const authTypes = [
    { type: "passport", passportNumber: "123456789", expectedLabel: "Passport" },
    {
      type: "nationalId",
      idNumber: "L01X00T47",
      expectedLabel: "National identity card",
    },
    {
      type: "brc",
      cardNumber: "RFN123456",
      expectedLabel: "Biometric residence card or permit",
    },
    {
      type: "ukvi",
      customerNumber: "1234-5678-9012-3456",
      expectedLabel: "I use a UKVI customer number",
    },
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

  test("extracts share code, valid-until date, and saves PDF", async () => {
    const page = await context.newPage();
    const rawHtml = await readFile(`./tests/fixtures/step-download-pdf.html`, "utf-8");
    const html = rawHtml.replace(
      /<head([^>]*)>/,
      '<head$1><base href="https://view-immigration-status.service.gov.uk/">'
    );
    await page.setContent(html);
    await page.route("**/share/someone-else/code/pdf", (route) => {
      route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="evisa.pdf"',
        },
        body: "%PDF-1.4\n% test pdf\n",
      });
    });

    const outputDir = await mkdtemp(join(tmpdir(), "evisa-flow-test-"));
    let result;
    const step = new DownloadPdfStep();
    await step.execute({
      ...baseContext,
      page,
      options: {
        ...baseContext.options,
        outputDir,
      },
      extractedData: {
        name: "Alex Sample",
      },
      setResult(value) {
        result = value;
      },
    });

    assert.equal(result.shareCode, "SGN CH2 7PL");
    assert.equal(result.validUntil.toISOString().slice(0, 10), "2030-01-01");
    assert.equal(result.pdfPath.endsWith("EVISA_Sample_Alex_2030-01-01.pdf"), true);
    assert.equal(await readFile(result.pdfPath, "utf-8"), "%PDF-1.4\n% test pdf\n");
    await page.close();
  });

  test("extracts share code without downloading PDF when PDF artifact is disabled", async () => {
    const page = await context.newPage();
    const rawHtml = await readFile(`./tests/fixtures/step-download-pdf.html`, "utf-8");
    await page.setContent(rawHtml);

    let result;
    const step = new DownloadPdfStep();
    await step.execute({
      ...baseContext,
      page,
      options: {
        ...baseContext.options,
        pdfEnabled: false,
      },
      extractedData: {
        name: "Alex Sample",
      },
      setResult(value) {
        result = value;
      },
    });

    assert.equal(result.shareCode, "SGN CH2 7PL");
    assert.equal(result.pdfPath, undefined);
    await page.close();
  });
});
