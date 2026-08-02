import assert from "node:assert/strict";
import test from "node:test";
import * as api from "../dist/index.js";
import {
  ApplicantSchema,
  formatShareCodeValidUntil,
  MobileApiErrorSchema,
  MobileMeSchema,
  MobileRunClaimResultSchema,
  MobileRunCreateRequestSchema,
  MobileRunSnapshotSchema,
  shareCodeExpiryDeadlineMs,
} from "../dist/protocol/index.js";
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

test("protocol schemas validate platform-neutral applicants", () => {
  const applicant = ApplicantSchema.parse({
    identityDocument: { type: "passport", number: "123456789" },
    dateOfBirth: "1980-03-31",
  });

  assert.equal(applicant.identityDocument.type, "passport");
  assert.throws(() =>
    ApplicantSchema.parse({
      identityDocument: { type: "passport", number: "not valid!" },
      dateOfBirth: "1980-02-31",
    })
  );
});

test("mobile run protocol rejects incomplete authority metadata", () => {
  const request = {
    clientRunId: "b7d0648e-9bf2-46e9-a238-98061470f42c",
    profileId: "1f8f9e99-f0ea-4591-a745-aabf871febc1",
    applicant: {
      identityDocument: { type: "passport", number: "123456789" },
      dateOfBirth: "1980-03-31",
    },
    purpose: "immigration_status_other",
    preferredTwoFactorMethod: "sms",
    authorityBasis: "authorised_proxy",
    attestedAt: "2026-08-01T09:00:00.000Z",
    termsVersion: "2026-08-01",
  };

  assert.equal(
    MobileRunCreateRequestSchema.parse(request).authorityBasis,
    "authorised_proxy"
  );
  assert.equal(
    MobileRunCreateRequestSchema.safeParse({ ...request, termsVersion: "" }).success,
    false
  );
});

test("mobile API schemas validate snapshots, entitlements, and claimed artifacts", () => {
  const runId = "c6d85ab7-22cd-4ef7-a394-e82c0fd8226b";
  const profileId = "1f8f9e99-f0ea-4591-a745-aabf871febc1";
  const now = "2026-08-01T09:00:00.000Z";
  const artifact = {
    id: "1df5b293-76a3-4a95-994b-8c98cc9fa260",
    kind: "evisa_pdf",
    filename: "eVisa proof.pdf",
    contentType: "application/pdf",
    byteLength: 1024,
    sha256: "a".repeat(64),
  };

  assert.equal(
    MobileRunSnapshotSchema.parse({
      id: runId,
      clientRunId: runId,
      profileId,
      purpose: "right_to_work",
      status: "awaiting_2fa",
      phase: "waiting_for_2fa",
      challenge: {
        type: "security_code",
        deliveryMethod: "sms",
        deadlineMs: Date.now() + 60_000,
      },
      createdAt: now,
      updatedAt: now,
    }).status,
    "awaiting_2fa"
  );
  assert.equal(
    MobileMeSchema.parse({
      userId: "9591fc30-b78f-4282-8fc9-ae662d725ad1",
      entitlement: "free",
      profileLimit: 1,
      activeProfileCount: 1,
      successfulRunCount: 0,
      remainingFreeRuns: 3,
      serviceStatus: "available",
    }).remainingFreeRuns,
    3
  );
  const claim = MobileRunClaimResultSchema.parse({
    shareCode: "W12 345 678",
    validUntil: "2026-10-30",
    artifacts: [artifact],
  });
  assert.equal(claim.validUntil, "2026-10-30");
  assert.equal(claim.artifacts[0].kind, "evisa_pdf");
  assert.equal(
    MobileRunClaimResultSchema.safeParse({
      shareCode: "W12 345 678",
      validUntil: "2026-10-30T09:00:00.000Z",
      artifacts: [artifact],
    }).success,
    true
  );
  assert.equal(
    MobileRunClaimResultSchema.safeParse({
      shareCode: "W12 345 678",
      validUntil: "2026-02-30",
      artifacts: [artifact],
    }).success,
    false
  );
  assert.equal(
    MobileApiErrorSchema.safeParse({ code: "NOPE", message: "", retryable: true })
      .success,
    false
  );
});

test("share-code expiry dates remain calendar-stable and inclusive", () => {
  assert.equal(
    formatShareCodeValidUntil("2026-10-30", {
      dateStyle: "long",
      timeZone: "America/Los_Angeles",
    }),
    "30 October 2026"
  );
  assert.equal(
    shareCodeExpiryDeadlineMs("2026-10-30"),
    Date.parse("2026-10-30T23:59:59.999Z")
  );
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
