#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const readJson = async (path) => JSON.parse(await readFile(path, "utf-8"));

const rootPackage = await readJson("package.json");
const servicePackage = await readJson("service/package.json");
const nodeMajor = (await readFile(".node-version", "utf-8")).trim();
const playwrightVersion = rootPackage.dependencies?.playwright;
const errors = [];

if (!/^\d+\.\d+\.\d+$/.test(playwrightVersion ?? "")) {
  errors.push("package.json must pin Playwright to an exact version");
}

for (const dockerfile of ["Dockerfile", "service/Dockerfile"]) {
  const contents = await readFile(dockerfile, "utf-8");
  const imageVersion = contents.match(/^ARG PLAYWRIGHT_VERSION=(\S+)$/m)?.[1];
  if (imageVersion !== playwrightVersion) {
    errors.push(
      `${dockerfile} uses Playwright ${imageVersion ?? "UNKNOWN"}; expected ${playwrightVersion}`
    );
  }
}

const rootNodeEngine = rootPackage.engines?.node;
const serviceNodeEngine = servicePackage.engines?.node;
if (rootNodeEngine !== serviceNodeEngine) {
  errors.push("root and service Node.js engine ranges must match");
}
if (!rootNodeEngine?.startsWith(`>=${nodeMajor}.`)) {
  errors.push(
    `Node.js engine ${rootNodeEngine ?? "UNKNOWN"} does not match .node-version ${nodeMajor}`
  );
}

if (errors.length > 0) {
  throw new Error(`Toolchain version mismatch:\n- ${errors.join("\n- ")}`);
}

process.stdout.write(
  `Toolchain aligned: Node.js ${rootNodeEngine}, Playwright ${playwrightVersion}\n`
);
