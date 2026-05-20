import { spawn } from "node:child_process";

const maxAttempts = 3;
const retryDelayMs = 10_000;
const retryableOutput =
  /(ECONNRESET|EAI_AGAIN|ETIMEDOUT|503|502|504|bad gateway|service unavailable)/i;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runAudit = () =>
  new Promise((resolve) => {
    const child = spawn("pnpm", ["audit", "--prod", "--audit-level", "high"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        npm_config_audit_level: "high",
      },
    });
    let output = "";

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      output += String(chunk);
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, output });
    });
  });

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const result = await runAudit();
  if (result.code === 0) {
    process.exit(0);
  }

  const canRetry = retryableOutput.test(result.output) && attempt < maxAttempts;
  if (!canRetry) {
    process.exit(result.code);
  }

  console.error(
    `pnpm audit failed with a registry error; retrying (${attempt}/${maxAttempts})...`
  );
  await delay(retryDelayMs);
}
