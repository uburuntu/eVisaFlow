import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { chromium } from "playwright";
import { FlowCancelledError } from "../dist/index.js";
import {
  ConfirmationStep,
  DateOfBirthStep,
  DocumentNumberStep,
  DocumentTypeStep,
  DownloadPdfStep,
  EntryPageStep,
  ProveStatusStep,
  PurposeSelectionStep,
  StepRunner,
  SummaryStep,
  TwoFactorCodeStep,
  TwoFactorMethodStep,
} from "../dist/unstable/testing.js";

let browser;
let context;

const pdf = Buffer.from("%PDF-1.4\n% evisa-flow core path test pdf\n%%EOF\n", "utf-8");

const noopLogger = {
  step() {},
  action() {},
  info() {},
  warn() {},
  error() {},
  debug() {},
  screenshot() {},
};

const baseOptions = {
  headless: true,
  verbose: false,
  pdfEnabled: true,
  pdfOutput: "bytes",
  pdfMaxBytes: 10 * 1024 * 1024,
  outputDir: "/tmp/test",
  outputFile: "",
  userDataDir: "",
  diagnosticsMode: "off",
  diagnosticsDir: "/tmp/test/debug",
  navigationTimeoutMs: 10_000,
  actionTimeoutMs: 5_000,
  twoFactorTimeoutMs: 10_000,
};

const steps = () => [
  new EntryPageStep(),
  new DocumentTypeStep(),
  new DocumentNumberStep(),
  new DateOfBirthStep(),
  new TwoFactorMethodStep(),
  new TwoFactorCodeStep(),
  new ProveStatusStep(),
  new ConfirmationStep(),
  new PurposeSelectionStep(),
  new SummaryStep(),
  new DownloadPdfStep(),
];

const authCases = [
  {
    type: "passport",
    expectedDocumentType: "PASSPORT",
    number: "123456789",
    numberLabel: "Passport number",
    credentials: { auth: { type: "passport", passportNumber: "123456789" } },
  },
  {
    type: "nationalId",
    expectedDocumentType: "ID_CARD",
    number: "L01X00T47",
    numberLabel: "National identity card number",
    credentials: { auth: { type: "nationalId", idNumber: "L01X00T47" } },
  },
  {
    type: "brc",
    expectedDocumentType: "BRC_CARD",
    number: "RFN123456",
    numberLabel: "Biometric residence card or permit number",
    credentials: { auth: { type: "brc", cardNumber: "RFN123456" } },
  },
  {
    type: "ukvi",
    expectedDocumentType: "CUSTOMER_REFERENCE",
    number: "1234-5678-9012-3456",
    numberLabel: "UKVI customer number",
    credentials: {
      auth: { type: "ukvi", customerNumber: "1234-5678-9012-3456" },
    },
  },
];

const pageShell = (body) =>
  `<!doctype html><html><head><title>Test</title></head><body><main>${body}</main></body></html>`;

const documentTypePage = () =>
  pageShell(`
    <h1>Which identity document do you use to sign in to your UKVI account?</h1>
    <form action="/document-number" method="get">
      <input type="radio" id="passport" name="documentType" value="PASSPORT"><label for="passport">Passport</label>
      <input type="radio" id="id-card" name="documentType" value="ID_CARD"><label for="id-card">National identity card</label>
      <input type="radio" id="brc-card" name="documentType" value="BRC_CARD"><label for="brc-card">Biometric residence card or permit</label>
      <input type="radio" id="customer-reference" name="documentType" value="CUSTOMER_REFERENCE"><label for="customer-reference">I use a UKVI customer number</label>
      <button type="submit">Continue</button>
    </form>
  `);

const documentNumberPage = (label) =>
  pageShell(`
    <h1>What is your ${label.toLowerCase()}?</h1>
    <form action="/date-of-birth" method="get">
      <label for="documentNumber">${label}</label>
      <input id="documentNumber" name="documentNumber">
      <button type="submit">Continue</button>
    </form>
  `);

const dateOfBirthPage = () =>
  pageShell(`
    <h1>What is your date of birth?</h1>
    <form action="/profile" method="get">
      <input name="dob-day" autocomplete="bday-day">
      <input name="dob-month" autocomplete="bday-month">
      <input name="dob-year" autocomplete="bday-year">
      <button type="submit">Continue</button>
    </form>
  `);

const profilePage = () =>
  pageShell(`
    <h1>Your immigration status</h1>
    <dl class="govuk-summary-list">
      <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Name</dt><dd class="govuk-summary-list__value">Ada Lovelace</dd></div>
      <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Status</dt><dd class="govuk-summary-list__value">Settled status</dd></div>
    </dl>
    <a class="govuk-button" href="/get-share-code">Get a share code</a>
  `);

const confirmationPage = () =>
  pageShell(`
    <h1>Get a share code to prove your status</h1>
    <a class="govuk-button" href="/share">Get share code</a>
  `);

const purposePage = () =>
  pageShell(`
    <h1>Why do you need a share code?</h1>
    <form action="/share/preview" method="get">
      <input type="radio" id="somethingElse" name="listedPurpose" value="To prove my immigration status for anything else">
      <label for="somethingElse">To prove my immigration status for anything else</label>
      <button type="submit">Continue</button>
    </form>
  `);

const summaryPage = () =>
  pageShell(`
    <h1>This is what the checker will see</h1>
    <dl class="govuk-summary-list">
      <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Name</dt><dd class="govuk-summary-list__value">Ada Lovelace</dd></div>
      <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Date of birth</dt><dd class="govuk-summary-list__value">31 March 1980</dd></div>
      <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Nationality</dt><dd class="govuk-summary-list__value">Testland</dd></div>
      <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Status</dt><dd class="govuk-summary-list__value">Settled status</dd></div>
      <div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Valid until</dt><dd class="govuk-summary-list__value">23 July 2026</dd></div>
    </dl>
    <a class="govuk-button" href="/share/abc/code">Create a share code</a>
  `);

const shareCodePage = () =>
  pageShell(`
    <h1>Details you need to share</h1>
    <p class="gov-uk-share-code">ABC DEF 123</p>
    <p>This code is valid until 23 July 2026.</p>
    <a href="/share/abc/code/pdf">Download PDF</a>
  `);

before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ acceptDownloads: true });
});

after(async () => {
  await browser?.close();
});

describe("core share-code flow", () => {
  for (const authCase of authCases) {
    test(`runs the routed flow for ${authCase.type}`, async () => {
      const page = await context.newPage();
      const visitedUrls = [];
      const timingEvents = [];

      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        visitedUrls.push(url.href);

        if (
          url.pathname === "/evisa/view-evisa-get-share-code-prove-immigration-status"
        ) {
          await route.fulfill({
            contentType: "text/html",
            body: pageShell(
              '<h1>View your eVisa and get a share code</h1><p>UKVI account</p><a href="https://view-immigration-status.service.gov.uk/status">View your eVisa and get a share code</a>'
            ),
          });
          return;
        }
        if (url.pathname === "/status") {
          await route.fulfill({ contentType: "text/html", body: documentTypePage() });
          return;
        }
        if (url.pathname === "/document-number") {
          assert.equal(
            url.searchParams.get("documentType"),
            authCase.expectedDocumentType
          );
          await route.fulfill({
            contentType: "text/html",
            body: documentNumberPage(authCase.numberLabel),
          });
          return;
        }
        if (url.pathname === "/date-of-birth") {
          assert.equal(url.searchParams.get("documentNumber"), authCase.number);
          await route.fulfill({ contentType: "text/html", body: dateOfBirthPage() });
          return;
        }
        if (url.pathname === "/profile") {
          assert.equal(url.searchParams.get("dob-day"), "31");
          assert.equal(url.searchParams.get("dob-month"), "3");
          assert.equal(url.searchParams.get("dob-year"), "1980");
          await route.fulfill({ contentType: "text/html", body: profilePage() });
          return;
        }
        if (url.pathname === "/get-share-code") {
          await route.fulfill({ contentType: "text/html", body: confirmationPage() });
          return;
        }
        if (url.pathname === "/share") {
          await route.fulfill({ contentType: "text/html", body: purposePage() });
          return;
        }
        if (url.pathname === "/share/preview") {
          assert.equal(
            url.searchParams.get("listedPurpose"),
            "To prove my immigration status for anything else"
          );
          await route.fulfill({ contentType: "text/html", body: summaryPage() });
          return;
        }
        if (url.pathname === "/share/abc/code") {
          await route.fulfill({ contentType: "text/html", body: shareCodePage() });
          return;
        }
        if (url.pathname === "/share/abc/code/pdf") {
          await route.fulfill({
            headers: {
              "content-disposition": 'attachment; filename="evisa.pdf"',
              "content-type": "application/pdf",
            },
            body: pdf,
          });
          return;
        }

        await route.fulfill({ status: 404, body: "not found" });
      });

      const runner = new StepRunner({
        steps: steps(),
        context: {
          credentials: {
            ...authCase.credentials,
            dateOfBirth: { day: 31, month: 3, year: 1980 },
          },
          purpose: "immigration_status_other",
          options: baseOptions,
          logger: noopLogger,
          page,
          extractedData: {},
          emit: (event) => {
            if (event.type === "timing") {
              timingEvents.push(event);
            }
          },
          onTwoFactorRequired: async () => "123456",
        },
      });

      const result = await runner.run(
        "https://www.gov.uk/evisa/view-evisa-get-share-code-prove-immigration-status"
      );
      await page.close();

      assert.equal(result.shareCode, "ABC DEF 123");
      assert.equal(result.summary?.name, "Ada Lovelace");
      assert.equal(result.pdfBytes instanceof Uint8Array, true);
      assert.equal(Buffer.from(result.pdfBytes).subarray(0, 5).toString(), "%PDF-");
      assert.equal(
        visitedUrls.some((url) => url.includes("/document-number")),
        true
      );
      assert.equal(
        timingEvents.some((event) => event.operation === "step"),
        true
      );
      assert.equal(
        timingEvents.some((event) => event.operation === "run"),
        true
      );
    });
  }
});

test("two-factor step aborts immediately when the run signal is cancelled", async () => {
  const page = await context.newPage();
  await page.setContent(
    pageShell(`
      <h1>Check your phone</h1>
      <label for="verificationCode">Security code</label>
      <input id="verificationCode" name="verificationCode">
      <button type="submit">Continue</button>
    `)
  );

  const controller = new AbortController();
  const step = new TwoFactorCodeStep();
  const startedAt = Date.now();
  setTimeout(() => controller.abort(new Error("User cancelled")), 20);

  await assert.rejects(
    step.execute({
      credentials: {
        auth: { type: "passport", passportNumber: "123456789" },
        dateOfBirth: { day: 31, month: 3, year: 1980 },
      },
      purpose: "immigration_status_other",
      options: baseOptions,
      logger: noopLogger,
      page,
      signal: controller.signal,
      extractedData: {},
      emit() {},
      setResult() {},
      addArtifacts() {},
      onTwoFactorRequired: async () =>
        new Promise(() => {
          // The test should complete via abort, not timeout.
        }),
    }),
    FlowCancelledError
  );

  assert.equal(Date.now() - startedAt < 1_000, true);
  await page.close();
});

test("download step rejects non-PDF attachments before returning bytes", async () => {
  const page = await context.newPage();
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/share/abc/code") {
      await route.fulfill({ contentType: "text/html", body: shareCodePage() });
      return;
    }
    if (url.pathname === "/share/abc/code/pdf") {
      await route.fulfill({
        headers: {
          "content-disposition": 'attachment; filename="evisa.pdf"',
          "content-type": "text/html",
        },
        body: "<html><body>Service unavailable</body></html>",
      });
      return;
    }
    await route.fulfill({ status: 404, body: "not found" });
  });

  await page.goto("https://example.test/share/abc/code");
  const step = new DownloadPdfStep();

  await assert.rejects(
    step.execute({
      credentials: {
        auth: { type: "passport", passportNumber: "123456789" },
        dateOfBirth: { day: 31, month: 3, year: 1980 },
      },
      purpose: "immigration_status_other",
      options: baseOptions,
      logger: noopLogger,
      page,
      extractedData: { name: "Ada Lovelace" },
      emit() {},
      setResult() {},
      addArtifacts() {},
      onTwoFactorRequired: async () => "123456",
    }),
    (error) =>
      error instanceof Error &&
      error.message.includes("Downloaded file did not look like a PDF")
  );

  await page.close();
});
