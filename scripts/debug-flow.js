#!/usr/bin/env node
import { EVisaFlow } from "../dist/index.js";

// ⚠️  IMPORTANT: Replace these with your actual credentials for testing
// This file is gitignored to prevent committing personal data
// Sample data format:
const credentials = {
  auth: { type: "passport", passportNumber: "123456789" },
  dateOfBirth: { day: 7, month: 6, year: 1998 },
  preferredTwoFactorMethod: "sms",
};

const flow = new EVisaFlow({
  credentials,
  purpose: "immigration_status_other",
  onTwoFactorRequired: async (method) => {
    console.log(`\n⚠️  Two-factor authentication required via ${method.toUpperCase()}`);
    console.log("Please check your phone/email and enter the 6-digit code:");
    
    const readline = await import("readline");
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
  },
  options: {
    headless: false, // Run headed for debugging
    verbose: true,
    screenshotOnError: true,
    outputDir: "./downloads",
    navigationTimeoutMs: 120_000, // 2 minutes
    actionTimeoutMs: 60_000, // 1 minute
  },
});

console.log("🚀 Starting eVisa flow...");
console.log("📋 Credentials:", {
  ...credentials,
  auth: { ...credentials.auth, passportNumber: "***" },
});
console.log("📁 Output directory: ./downloads");
console.log("📸 Debug screenshots: ./downloads/debug\n");

flow
  .run()
  .then((result) => {
    console.log("\n✅ Success! Flow completed.");
    console.log("📄 PDF saved to:", result.pdfPath);
    console.log("🔑 Share code:", result.shareCode);
    if (result.validUntil) {
      console.log("⏰ Valid until:", result.validUntil.toISOString());
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
