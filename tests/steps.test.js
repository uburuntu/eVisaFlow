import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import { chromium } from "playwright";
import {
  classifyPage,
  createPageSnapshot,
  DocumentNumberStep,
  DocumentTypeStep,
  DownloadPdfStep,
  ProveStatusStep,
  SummaryStep,
  sanitizeSegment,
} from "../dist/unstable/testing.js";

const pageFixtures = [
  { file: "step-entry-page.html", kind: "entry_page" },
  { file: "step-document-type.html", kind: "document_type" },
  { file: "step-document-number.html", kind: "document_number" },
  { file: "step-document-number-national-id.html", kind: "document_number" },
  { file: "step-document-number-brc.html", kind: "document_number" },
  { file: "step-document-number-ukvi.html", kind: "document_number" },
  { file: "step-date-of-birth.html", kind: "date_of_birth" },
  { file: "step-two-factor-method.html", kind: "two_factor_method" },
  { file: "step-two-factor-code.html", kind: "two_factor_code" },
  { file: "step-prove-status.html", kind: "prove_status" },
  { file: "step-confirmation.html", kind: "confirmation" },
  { file: "step-purpose-selection.html", kind: "purpose_selection" },
  { file: "step-summary.html", kind: "summary" },
  { file: "step-download-pdf.html", kind: "download_pdf" },
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
    pdfEnabled: true,
    pdfOutput: "file",
    outputDir: "/tmp/test",
    outputFile: "",
    userDataDir: "",
    diagnosticsMode: "off",
    diagnosticsDir: "/tmp/test/debug",
    navigationTimeoutMs: 60000,
    actionTimeoutMs: 30000,
    twoFactorTimeoutMs: 600000,
    pdfMaxBytes: 10 * 1024 * 1024,
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

test("filename segments remain usable for non-ASCII names", () => {
  assert.equal(sanitizeSegment("Elodie"), "Elodie");
  assert.equal(sanitizeSegment("Élodie"), "Elodie");
  assert.equal(sanitizeSegment("李"), "UNKNOWN");
});

describe("page classification", () => {
  test("classifies fixture pages with evidence", async () => {
    for (const { file, kind } of pageFixtures) {
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

  test("classifies core auth pages from stable form signatures", async () => {
    const cases = [
      {
        kind: "document_type",
        html: '<form><input type="radio" name="documentType" value="PASSPORT"></form>',
      },
      {
        kind: "document_number",
        html: '<form><label for="documentNumber">Travel document</label><input id="documentNumber" name="documentNumber"></form>',
      },
      {
        kind: "date_of_birth",
        html: '<form><input name="dob-day"><input name="dob-month"><input name="dob-year"></form>',
      },
      {
        kind: "two_factor_method",
        html: '<form><input type="radio" name="deliveryMethod" value="SMS"></form>',
      },
      {
        kind: "two_factor_code",
        html: '<h1>Security check</h1><form><label for="verificationCode">Security code</label><input id="verificationCode" name="verificationCode"></form>',
      },
    ];

    for (const { kind, html } of cases) {
      const page = await context.newPage();
      await page.setContent(html);
      const classification = classifyPage(await createPageSnapshot(page));
      await page.close();
      assert.equal(classification.kind, kind);
    }
  });

  test("classifies GOV.UK auth page from title while body is still settling", () => {
    const classification = classifyPage({
      url: "https://user-auth.apply-to-visit-or-stay-in-the-uk.homeoffice.gov.uk/auth/realms/AUK/protocol/openid-connect/auth",
      title: "Which identity document do you use to sign in to your UKVI account?",
      text: "",
      headings: [],
      buttons: [],
      links: [],
      controls: [],
      errors: [],
    });

    assert.equal(classification.kind, "document_type");
    assert.equal(classification.evidence.includes("title:identity-document"), true);
  });

  test("classifies share preview page while create action is still settling", () => {
    const classification = classifyPage({
      url: "https://view-immigration-status.service.gov.uk/share/someone-else",
      title: "Preview your information - GOV.UK",
      text: "",
      headings: ["This is what the checker will see"],
      buttons: [],
      links: [],
      controls: [],
      errors: [],
    });

    assert.equal(classification.kind, "summary");
    assert.equal(classification.evidence.includes("url:share-preview"), true);
  });

  test("snapshots form controls outside main content", async () => {
    const page = await context.newPage();
    await page.setContent(
      '<form><input type="radio" name="documentType" value="PASSPORT"></form>'
    );

    const snapshot = await createPageSnapshot(page);
    await page.close();

    assert.equal(
      snapshot.controls.some((control) => control.name === "documentType"),
      true
    );
  });
});

describe("ProveStatusStep execute", () => {
  test("captures rich authenticated status HTML before leaving the page", async () => {
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/dist/assets/app-3cff3275.css") {
        await route.fulfill({
          contentType: "text/css",
          body: ".govuk-summary-list__row{display:block}",
        });
        return;
      }
      if (url.pathname === "/get-share-code") {
        await route.fulfill({
          contentType: "text/html",
          body: "<h1>Get a share code to prove your status</h1>",
        });
        return;
      }
      await route.fulfill({ status: 404, body: "not found" });
    });
    const rawHtml = await readFile(`./tests/fixtures/step-prove-status.html`, "utf-8");
    const html = rawHtml.replace(
      /<head([^>]*)>/,
      '<head$1><base href="https://view-immigration-status.service.gov.uk/">'
    );
    await page.setContent(html);

    const extractedData = {};
    const step = new ProveStatusStep();
    await step.execute({
      ...baseContext,
      page,
      options: {
        ...baseContext.options,
        navigationTimeoutMs: 500,
        actionTimeoutMs: 500,
        checker: {
          enabled: true,
          html: {
            enabled: true,
            mode: "bytes",
            directory: "",
            maxBytes: 2 * 1024 * 1024,
            inlineImages: true,
            inlineStyles: true,
          },
        },
      },
      extractedData,
    });

    assert.equal(extractedData.checkerHtml?.kind, "bytes");
    const statusHtml = Buffer.from(extractedData.checkerHtml.bytes).toString("utf-8");
    assert.match(statusHtml, /Your immigration status/);
    assert.match(statusHtml, /What you can do in the UK/);
    assert.match(statusHtml, /What you cannot do/);
    assert.match(statusHtml, /<img[^>]+id="photo"/);
    assert.match(statusHtml, /data:image\/gif;base64/);
    assert.equal(statusHtml.includes("session-timeout-start"), false);
    await page.close();
  });
});

describe("DocumentTypeStep execute", () => {
  const authTypes = [
    { type: "passport", passportNumber: "123456789", expectedValue: "PASSPORT" },
    {
      type: "nationalId",
      idNumber: "L01X00T47",
      expectedValue: "ID_CARD",
    },
    {
      type: "brc",
      cardNumber: "RFN123456",
      expectedValue: "BRC_CARD",
    },
    {
      type: "ukvi",
      customerNumber: "1234-5678-9012-3456",
      expectedValue: "CUSTOMER_REFERENCE",
    },
  ];

  for (const authData of authTypes) {
    test(`selects ${authData.type} radio and submits`, async () => {
      const page = await context.newPage();
      const html = await readFile(`./tests/fixtures/step-document-type.html`, "utf-8");
      await page.setContent(html);
      await page.locator("form").evaluate((form) => {
        form.addEventListener("submit", (event) => event.preventDefault());
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
      assert.equal(
        await page
          .locator(`input[name="documentType"][value="${authData.expectedValue}"]`)
          .isChecked(),
        true
      );
      await page.close();
    });
  }
});

describe("DocumentNumberStep execute", () => {
  const cases = [
    {
      fixture: "step-document-number.html",
      auth: { type: "passport", passportNumber: "123456789" },
      expectedValue: "123456789",
    },
    {
      fixture: "step-document-number-national-id.html",
      auth: { type: "nationalId", idNumber: "L01X00T47" },
      expectedValue: "L01X00T47",
    },
    {
      fixture: "step-document-number-brc.html",
      auth: { type: "brc", cardNumber: "RFN123456" },
      expectedValue: "RFN123456",
    },
    {
      fixture: "step-document-number-ukvi.html",
      auth: { type: "ukvi", customerNumber: "1234-5678-9012-3456" },
      expectedValue: "1234-5678-9012-3456",
    },
  ];

  for (const { fixture, auth, expectedValue } of cases) {
    test(`fills ${auth.type} document number and submits`, async () => {
      const page = await context.newPage();
      const html = await readFile(`./tests/fixtures/${fixture}`, "utf-8");
      await page.setContent(html);
      await page.locator("form").evaluate((form) => {
        form.addEventListener("submit", (event) => event.preventDefault());
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
      assert.equal(
        await page.locator('input[name="documentNumber"]').inputValue(),
        expectedValue
      );
      await page.close();
    });
  }
});

describe("SummaryStep execute", () => {
  test("clicks a create-share-code submit button", async () => {
    const page = await context.newPage();
    await page.setContent(`
      <main>
        <h1>This is what the checker will see</h1>
        <dl class="govuk-summary-list">
          <div class="govuk-summary-list__row">
            <dt class="govuk-summary-list__key">Name</dt>
            <dd class="govuk-summary-list__value">Alex Sample</dd>
          </div>
        </dl>
        <form onsubmit="document.body.textContent = 'created'; return false;">
          <button type="submit">Create share code</button>
        </form>
      </main>
    `);

    const step = new SummaryStep();
    await step.execute({ ...baseContext, page });

    assert.match(await page.locator("body").innerText(), /created/);
    await page.close();
  });
});

describe("DownloadPdfStep", () => {
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

  test("extracts share code and returns PDF bytes without saving a file", async () => {
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
        body: "%PDF-1.4\n% bytes pdf\n",
      });
    });

    let result;
    const artifacts = [];
    const step = new DownloadPdfStep();
    await step.execute({
      ...baseContext,
      page,
      options: {
        ...baseContext.options,
        pdfOutput: "bytes",
      },
      extractedData: {
        name: "Alex Sample",
      },
      setResult(value) {
        result = value;
      },
      addArtifacts(value) {
        artifacts.push(...value);
      },
    });

    assert.equal(result.shareCode, "SGN CH2 7PL");
    assert.equal(result.pdfPath, undefined);
    assert.equal(result.pdfFilename, "EVISA_Sample_Alex_2030-01-01.pdf");
    assert.equal(
      result.pdfBytes.byteLength,
      Buffer.byteLength("%PDF-1.4\n% bytes pdf\n")
    );
    assert.equal(
      Buffer.from(result.pdfBytes).toString("utf-8"),
      "%PDF-1.4\n% bytes pdf\n"
    );
    assert.deepEqual(artifacts, []);
    await page.close();
  });

  test("rejects bytes mode when the download is not a PDF", async () => {
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
          "content-type": "text/plain",
          "content-disposition": 'attachment; filename="evisa.txt"',
        },
        body: "not a pdf",
      });
    });

    const step = new DownloadPdfStep();
    await assert.rejects(
      step.execute({
        ...baseContext,
        page,
        options: {
          ...baseContext.options,
          pdfOutput: "bytes",
        },
        extractedData: {
          name: "Alex Sample",
        },
      }),
      /Downloaded file did not look like a PDF/
    );
    await page.close();
  });

  test("rejects bytes mode when the download exceeds the memory cap", async () => {
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
        body: `%PDF-1.4\n${"x".repeat(64)}`,
      });
    });

    const step = new DownloadPdfStep();
    await assert.rejects(
      step.execute({
        ...baseContext,
        page,
        options: {
          ...baseContext.options,
          pdfOutput: "bytes",
          pdfMaxBytes: 8,
        },
        extractedData: {
          name: "Alex Sample",
        },
      }),
      /Downloaded PDF exceeded configured max size/
    );
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
