#!/usr/bin/env node
import { EVisaClient } from "../dist/index.js";

// Copy this sample to scripts/debug-flow.js and replace the applicant details there.
// The local script is gitignored to prevent committing personal data.
// Sample data format:
const applicant = {
  identityDocument: { type: "passport", number: "123456789" },
  dateOfBirth: "1998-06-07",
};

const askForCode = async (method) => {
  console.log(`\n⚠️  Two-factor authentication required via ${method.toUpperCase()}`);
  console.log("Please check your phone/email and enter the 6-digit code:");

  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question("Code: ", (code) => {
      rl.close();
      resolve(code.trim());
    });
  });
};

const client = new EVisaClient({
  browser: {
    headless: false, // Run headed for debugging
  },
  artifacts: {
    pdf: {
      directory: "./downloads",
    },
    diagnostics: {
      mode: "raw",
      directory: "./downloads/debug",
    },
  },
  timeouts: {
    navigationMs: 120_000, // 2 minutes
    actionMs: 60_000, // 1 minute
  },
  verbose: true,
});

console.log("🚀 Starting eVisa flow...");
console.log("📋 Applicant:", {
  ...applicant,
  identityDocument: { ...applicant.identityDocument, number: "***" },
});
console.log("📁 Output directory: ./downloads");
console.log("📸 Debug screenshots: ./downloads/debug\n");

client
  .createShareCode({
    applicant,
    purpose: "immigration_status_other",
    challengePreference: { deliveryMethod: "sms" },
    onChallenge: async (challenge) => ({
      code: await askForCode(challenge.deliveryMethod),
    }),
  })
  .then((result) => {
    console.log("\n✅ Success! Flow completed.");
    console.log("📄 PDF saved to:", result.pdf?.path ?? "(PDF disabled)");
    console.log("🔑 Share code:", result.shareCode);
    if (result.validUntil) {
      console.log("⏰ Valid until:", result.validUntil);
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Flow failed!");
    console.error("Error:", error.message);
    if (error.stack) {
      console.error("\nStack trace:");
      console.error(error.stack);
    }
    console.error("\n💡 Check ./downloads/debug/ for screenshots and HTML dumps");
    process.exit(1);
  });
