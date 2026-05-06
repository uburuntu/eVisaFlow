import assert from "node:assert/strict";
import test from "node:test";
import * as api from "../dist/index.js";

test("root package exposes the v2 client API without step internals", () => {
  assert.equal(typeof api.EVisaClient, "function");
  assert.equal(typeof api.EVisaError, "function");
  assert.equal(typeof api.ConfigError, "function");

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
