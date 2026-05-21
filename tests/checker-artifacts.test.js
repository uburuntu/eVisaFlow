import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { chromium } from "playwright";
import {
  captureStandaloneHtml,
  formatShareCode,
  runShareCodeCheck,
} from "../dist/unstable/testing.js";

let browser;
let context;

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);
const pdf = Buffer.from("%PDF-1.4\n% evisa-flow test pdf\n%%EOF\n", "utf-8");

const logger = {
  step() {},
  action() {},
  info() {},
  warn() {},
  error() {},
  debug() {},
  screenshot() {},
};

before(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ acceptDownloads: true });
});

after(async () => {
  await browser?.close();
});

describe("standalone checker HTML", () => {
  test("inlines stylesheet assets, image sources, srcsets, and inline style URLs", async () => {
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/status") {
        await route.fulfill({
          contentType: "text/html",
          body: [
            "<!doctype html>",
            "<html><head>",
            '<link rel="stylesheet" href="/style.css">',
            '<link rel="icon" href="/favicon.png">',
            "</head><body>",
            "<script>window.__runtime = true;</script>",
            '<form action="https://user-auth.apply-to-visit-or-stay-in-the-uk.homeoffice.gov.uk/auth/realms/AUK/login-actions/authenticate?session_code=secret&execution=secret&tab_id=secret">',
            '<input type="hidden" name="csrf" value="secret">',
            '<a href="https://user-auth.apply-to-visit-or-stay-in-the-uk.homeoffice.gov.uk/auth/realms/AUK/login-actions/authenticate?execution=secret&tab_id=secret">Back</a>',
            "</form>",
            "<main style=\"background-image: url('/inline-bg.png')\">",
            '<img src="/photo.png" srcset="/photo-small.png 1x, /photo-large.png 2x" alt="Profile">',
            "</main>",
            "</body></html>",
          ].join(""),
        });
        return;
      }
      if (url.pathname === "/style.css") {
        await route.fulfill({
          contentType: "text/css",
          body: ".photo { background-image: url('/bg.png'); }",
        });
        return;
      }
      if (
        [
          "/bg.png",
          "/favicon.png",
          "/inline-bg.png",
          "/photo.png",
          "/photo-large.png",
          "/photo-small.png",
        ].includes(url.pathname)
      ) {
        await route.fulfill({ contentType: "image/png", body: png });
        return;
      }
      await route.fulfill({ status: 404, body: "not found" });
    });

    await page.goto("https://example.test/status");
    const html = await captureStandaloneHtml(page);
    await page.close();

    assert.equal(html.includes("<script>"), false);
    assert.equal(html.includes("session_code"), false);
    assert.equal(html.includes("execution=secret"), false);
    assert.equal(html.includes("tab_id"), false);
    assert.equal(html.includes('value="secret"'), false);
    assert.equal(html.includes("action="), false);
    assert.match(html, /<style data-inlined-from="https:\/\/example\.test\/style\.css">/);
    assert.equal(html.includes("https://example.test/photo.png"), false);
    assert.equal(html.includes("https://example.test/bg.png"), false);
    assert.equal(html.includes("https://example.test/inline-bg.png"), false);
    assert.equal((html.match(/data:image\/png;base64,/g) ?? []).length >= 5, true);
  });

  test("skips stylesheet inlining when the stylesheet is over the asset byte limit", async () => {
    const page = await context.newPage();
    const largeCss = "body { color: #123456; background: #abcdef; }";
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/status") {
        await route.fulfill({
          contentType: "text/html",
          body: [
            "<!doctype html>",
            "<html><head>",
            '<link rel="stylesheet" href="/large.css" disabled>',
            "</head><body>Ready</body></html>",
          ].join(""),
        });
        return;
      }
      if (url.pathname === "/large.css") {
        await route.fulfill({
          headers: {
            "content-length": String(Buffer.byteLength(largeCss)),
            "content-type": "text/css",
          },
          body: largeCss,
        });
        return;
      }
      await route.fulfill({ status: 404, body: "not found" });
    });

    await page.goto("https://example.test/status");
    const html = await captureStandaloneHtml(page, { assetMaxBytes: 8 });
    await page.close();

    assert.equal(html.includes("<style"), false);
    assert.match(html, /href="https:\/\/example\.test\/large\.css"/);
  });

  test("applies the asset timeout to stylesheet fetches", async () => {
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/status") {
        await route.fulfill({
          contentType: "text/html",
          body: [
            "<!doctype html>",
            "<html><head>",
            '<link rel="stylesheet" href="/slow.css" disabled>',
            "</head><body>Ready</body></html>",
          ].join(""),
        });
        return;
      }
      if (url.pathname === "/slow.css") {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        await route
          .fulfill({
            contentType: "text/css",
            body: "body { color: #654321; }",
          })
          .catch(() => {});
        return;
      }
      await route.fulfill({ status: 404, body: "not found" });
    });

    await page.goto("https://example.test/status");
    const startedAt = Date.now();
    const html = await captureStandaloneHtml(page, { assetTimeoutMs: 50 });
    const elapsedMs = Date.now() - startedAt;
    await page.close();

    assert.equal(html.includes("#654321"), false);
    assert.match(html, /href="https:\/\/example\.test\/slow\.css"/);
    assert.equal(elapsedMs < 800, true);
  });
});

describe("share-code checker flow", () => {
  test("captures a standalone status page and checker PDF in bytes mode", async () => {
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/check-immigration-status") {
        await route.fulfill({
          contentType: "text/html",
          body: '<html><body><a class="govuk-button" href="/view/start">Start now</a></body></html>',
        });
        return;
      }
      if (url.pathname === "/view/start") {
        await route.fulfill({
          contentType: "text/html",
          body: '<form action="/view/date-of-birth" method="get"><label for="shareCode">Share code</label><input id="shareCode" name="shareCode"><button type="submit">Continue</button></form>',
        });
        return;
      }
      if (url.pathname === "/view/date-of-birth") {
        await route.fulfill({
          contentType: "text/html",
          body: [
            '<div class="govuk-cookie-banner">',
            '<div class="govuk-cookie-banner__message" role="alert">',
            "You have accepted analytics cookies. You can change your cookie settings at any time.",
            "</div>",
            "</div>",
            '<form action="/view/checker-details" method="get">',
            '<input id="dob-day" name="dob-day">',
            '<input id="dob-month" name="dob-month">',
            '<input id="dob-year" name="dob-year">',
            '<button type="submit">Continue</button>',
            "</form>",
          ].join(""),
        });
        return;
      }
      if (url.pathname === "/view/checker-details") {
        await route.fulfill({
          contentType: "text/html",
          body: [
            '<form action="/view/checker-purpose" method="get">',
            '<label for="jobTitle">Job title</label><input id="jobTitle" name="jobTitle">',
            '<label for="companyName">Organisation or company name</label><input id="companyName" name="companyName">',
            '<button type="submit">Continue</button>',
            "</form>",
          ].join(""),
        });
        return;
      }
      if (url.pathname === "/view/checker-purpose") {
        await route.fulfill({
          contentType: "text/html",
          body: [
            '<form action="/view/profile" method="get">',
            '<input type="radio" id="purpose-TRAVEL" name="purpose" value="TRAVEL">',
            '<label for="purpose-TRAVEL">Travel</label>',
            '<button type="submit">Continue</button>',
            "</form>",
          ].join(""),
        });
        return;
      }
      if (url.pathname === "/view/profile") {
        await route.fulfill({
          contentType: "text/html",
          body: [
            '<html><head><link rel="stylesheet" href="/checker.css"></head><body>',
            "<h1>Their immigration status</h1>",
            '<img src="/profile.png" alt="Profile photo">',
            '<dl class="govuk-summary-list">',
            '<div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Name</dt><dd class="govuk-summary-list__value">Ada Lovelace</dd></div>',
            '<div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Date of birth</dt><dd class="govuk-summary-list__value">31 March 1980</dd></div>',
            '<div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Nationality</dt><dd class="govuk-summary-list__value">Testland</dd></div>',
            '<div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Status</dt><dd class="govuk-summary-list__value">Settled status</dd></div>',
            '<div class="govuk-summary-list__row"><dt class="govuk-summary-list__key">Valid until</dt><dd class="govuk-summary-list__value">23 July 2026</dd></div>',
            "</dl>",
            '<p id="checkCompanyName">Self</p>',
            '<p id="checkJobTitle">Traveller</p>',
            '<p id="checkDate">19 May 2026</p>',
            '<p id="checkReferenceNumber">CHECK-123</p>',
            '<p id="checkPurpose">Travel</p>',
            "<h2>Summary of what they can do in the UK</h2>",
            "<p>They can:</p>",
            '<ul class="govuk-list govuk-list--bullet"><li>travel in and out of the country</li></ul>',
            "<h3>Things they cannot do</h3>",
            "<p>They cannot access public funds.</p>",
            '<a href="/view/profile/pdf?status=ltr">Download PDF</a>',
            "</body></html>",
          ].join(""),
        });
        return;
      }
      if (url.pathname === "/checker.css") {
        await route.fulfill({
          contentType: "text/css",
          body: "body { background-image: url('/checker-bg.png'); }",
        });
        return;
      }
      if (url.pathname === "/profile.png" || url.pathname === "/checker-bg.png") {
        await route.fulfill({ contentType: "image/png", body: png });
        return;
      }
      if (url.pathname === "/view/profile/pdf") {
        await route.fulfill({
          headers: {
            "content-disposition": 'attachment; filename="checker-status.pdf"',
            "content-type": "application/pdf",
          },
          body: pdf,
        });
        return;
      }
      await route.fulfill({ status: 404, body: "not found" });
    });

    const result = await runShareCodeCheck({
      page,
      shareCode: "abc def 123",
      dateOfBirth: { day: 31, month: 3, year: 1980 },
      artifacts: {
        enabled: true,
        html: {
          enabled: true,
          mode: "bytes",
          directory: "",
          maxBytes: 2 * 1024 * 1024,
          inlineImages: true,
          inlineStyles: true,
        },
        pdf: {
          enabled: true,
          mode: "bytes",
          directory: "",
          maxBytes: 2 * 1024 * 1024,
        },
      },
      navigationTimeoutMs: 5_000,
      logger,
      emit() {},
    });
    await page.close();

    assert.equal(formatShareCode("ABCDEF123"), "ABC DEF 123");
    assert.equal(result.shareCode, "ABC DEF 123");
    assert.equal(result.summary?.name, "Ada Lovelace");
    assert.equal(result.summary?.checkReferenceNumber, "CHECK-123");
    assert.deepEqual(result.summary?.can, ["travel in and out of the country"]);
    assert.deepEqual(result.summary?.cannot, ["They cannot access public funds."]);
    assert.equal(result.html?.kind, "bytes");
    assert.equal(result.html?.standalone, true);
    assert.match(
      Buffer.from(result.html.bytes).toString("utf-8"),
      /data:image\/png;base64,/
    );
    assert.equal(result.pdf?.kind, "bytes");
    assert.equal(Buffer.from(result.pdf.bytes).subarray(0, 5).toString(), "%PDF-");
  });

  test("classifies checker validation pages as authentication failures", async () => {
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/check-immigration-status") {
        await route.fulfill({
          contentType: "text/html",
          body: '<html><body><a class="govuk-button" href="/view/start">Start now</a></body></html>',
        });
        return;
      }
      if (url.pathname === "/view/start") {
        await route.fulfill({
          contentType: "text/html",
          body: '<form action="/view/date-of-birth" method="get"><label for="shareCode">Share code</label><input id="shareCode" name="shareCode"><button type="submit">Continue</button></form>',
        });
        return;
      }
      if (url.pathname === "/view/date-of-birth") {
        await route.fulfill({
          contentType: "text/html",
          body: '<div class="govuk-error-summary">The share code is not valid</div>',
        });
        return;
      }
      await route.fulfill({ status: 404, body: "not found" });
    });

    await assert.rejects(
      runShareCodeCheck({
        page,
        shareCode: "abc def 123",
        dateOfBirth: { day: 31, month: 3, year: 1980 },
        artifacts: {
          enabled: false,
          html: {
            enabled: false,
            mode: "bytes",
            directory: "",
            maxBytes: 2 * 1024 * 1024,
            inlineImages: true,
            inlineStyles: true,
          },
          pdf: {
            enabled: false,
            mode: "bytes",
            directory: "",
            maxBytes: 2 * 1024 * 1024,
          },
        },
        navigationTimeoutMs: 5_000,
        logger,
        emit() {},
      }),
      (error) => error.code === "AUTHENTICATION_FAILED"
    );
    await page.close();
  });
});
