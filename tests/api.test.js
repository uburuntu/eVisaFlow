import assert from "node:assert/strict";
import test from "node:test";
import * as api from "../dist/index.js";
import {
  ConfigSchema,
  createSanitizedDiagnosticSnapshot,
} from "../dist/unstable/testing.js";

test("root package exposes the v2 client API without step internals", () => {
  assert.equal(typeof api.EVisaClient, "function");
  assert.equal(typeof api.EVisaError, "function");
  assert.equal(typeof api.ConfigError, "function");
  assert.equal(typeof new api.EVisaClient().verifyShareCode, "function");

  assert.equal(api.EVisaFlow, undefined);
  assert.equal(api.EntryPageStep, undefined);
  assert.equal(api.DocumentTypeStep, undefined);
  assert.equal(api.DownloadPdfStep, undefined);
});

test("EVisaClient validates request shape before launching a browser", async () => {
  const client = new api.EVisaClient({
    artifacts: { pdf: false },
  });

  await assert.rejects(
    client.createShareCode({
      applicant: {
        identityDocument: { type: "passport", number: "123456789" },
        dateOfBirth: "1998-99-99",
      },
      onChallenge: async () => ({ code: "123456" }),
    }),
    (error) =>
      error instanceof api.ConfigError &&
      error.code === "CONFIG_INVALID" &&
      error.message.includes("valid calendar date")
  );
});

test("EVisaClient rejects impossible object dates before launching a browser", async () => {
  const client = new api.EVisaClient({
    artifacts: { pdf: false },
  });

  await assert.rejects(
    client.createShareCode({
      applicant: {
        identityDocument: { type: "passport", number: "123456789" },
        dateOfBirth: { day: 31, month: 2, year: 1980 },
      },
      onChallenge: async () => ({ code: "123456" }),
    }),
    (error) =>
      error instanceof api.ConfigError &&
      error.code === "CONFIG_INVALID" &&
      error.message.includes("valid calendar date")
  );
});

test("EVisaClient rejects filesystem PDF options in bytes mode", async () => {
  const client = new api.EVisaClient({
    artifacts: { pdf: { mode: "bytes", path: "ignored.pdf" } },
  });

  await assert.rejects(
    client.createShareCode({
      applicant: {
        identityDocument: { type: "passport", number: "123456789" },
        dateOfBirth: "1980-03-31",
      },
      onChallenge: async () => ({ code: "123456" }),
    }),
    (error) =>
      error instanceof api.ConfigError &&
      error.code === "CONFIG_INVALID" &&
      error.message.includes("only valid in file mode")
  );
});

test("EVisaClient validates checker requests before launching a browser", async () => {
  const client = new api.EVisaClient({
    artifacts: { checker: false },
  });

  await assert.rejects(
    client.verifyShareCode({
      shareCode: "too-short",
      dateOfBirth: "1980-03-31",
    }),
    (error) =>
      error instanceof api.ConfigError &&
      error.code === "CONFIG_INVALID" &&
      error.message.includes("shareCode")
  );
});

test("ConfigSchema accepts diagnostics mode alias on as sanitized", () => {
  const config = ConfigSchema.parse({
    artifacts: {
      diagnostics: { mode: "on" },
    },
  });

  assert.equal(config.artifacts?.diagnostics?.mode, "sanitized");
});

test("ConfigSchema accepts checker artifact options", () => {
  const config = ConfigSchema.parse({
    checkDetails: {
      jobTitle: "Traveller",
      organisation: "Self",
      purpose: "travel",
    },
    artifacts: {
      checker: {
        html: {
          mode: "bytes",
          maxBytes: 20 * 1024 * 1024,
          inlineImages: true,
          inlineStyles: true,
        },
        pdf: { mode: "bytes" },
      },
    },
  });

  assert.equal(config.checkDetails?.purpose, "travel");
  assert.equal(
    typeof config.artifacts?.checker === "object" &&
      config.artifacts.checker.html !== false,
    true
  );
});

test("sanitized diagnostics strip query strings and fragments from hrefs", () => {
  const snapshot = createSanitizedDiagnosticSnapshot({
    url: "https://example.com/auth?tab_id=secret#frag",
    title: "Title",
    text: "ignored text",
    headings: ["Heading"],
    buttons: ["Continue"],
    links: [
      {
        text: "Recover account",
        href: "https://example.com/recover?euaId=secret#frag",
      },
      { text: "Anchor", href: "#content" },
    ],
    controls: [
      {
        tag: "input",
        type: "text",
        id: "verificationCode",
        name: "verificationCode",
        value: "secret",
        label: "Secret code",
      },
    ],
    errors: [],
  });

  assert.equal(snapshot.url, "https://example.com/auth");
  assert.equal(snapshot.links[0].href, "https://example.com/recover");
  assert.equal(snapshot.links[1].href, undefined);
  assert.deepEqual(snapshot.controls[0], {
    tag: "input",
    type: "text",
    id: "verificationCode",
    name: "verificationCode",
    autocomplete: undefined,
  });
});
