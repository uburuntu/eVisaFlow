#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const SOURCE_DIR = "downloads/debug";
const TARGET_DIR = "tests/fixtures";

const FIXTURES = [
  "step-entry-page.html",
  "step-document-type.html",
  "step-document-number.html",
  "step-date-of-birth.html",
  "step-two-factor-method.html",
  "step-two-factor-code.html",
  "step-prove-status.html",
  "step-confirmation.html",
  "step-purpose-selection.html",
  "step-summary.html",
  "step-download-pdf.html",
];

const SAMPLE = {
  name: "Alex Sample",
  dateOfBirth: "1 January 1990",
  nationality: "GBR",
  status: "Skilled Worker",
  validFrom: "1 January 2020",
  validUntil: "1 January 2030",
  shareCode: "ABC DEF GHI",
  csrf: "REDACTED",
  pixel:
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
};

const escapeRegExp = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const replaceDefinition = (html, label, value) => {
  const pattern = new RegExp(
    `(<dt[^>]*>\\s*${escapeRegExp(label)}\\s*</dt>\\s*<dd[^>]*>)([^<]*)(</dd>)`,
    "i"
  );
  return html.replace(pattern, `$1${value}$3`);
};

const sanitizeHtml = (html) => {
  let output = html;

  output = replaceDefinition(output, "Name", SAMPLE.name);
  output = replaceDefinition(output, "Date of birth", SAMPLE.dateOfBirth);
  output = replaceDefinition(output, "Nationality", SAMPLE.nationality);
  output = replaceDefinition(output, "Status", SAMPLE.status);
  output = replaceDefinition(output, "Valid from", SAMPLE.validFrom);
  output = replaceDefinition(output, "Valid until", SAMPLE.validUntil);

  output = output.replace(
    /Date of birth\s+[0-9]{1,2}\s+\w+\s+\d{4}/gi,
    `Date of birth ${SAMPLE.dateOfBirth}`
  );
  output = output.replace(
    /valid until\s+[0-9]{1,2}\s+\w+\s+\d{4}/gi,
    `valid until ${SAMPLE.validUntil}`
  );

  output = output.replace(
    /Share code\s*([A-Z0-9]{3}\s+[A-Z0-9]{3}\s+[A-Z0-9]{3})/gi,
    `Share code ${SAMPLE.shareCode}`
  );
  output = output.replace(
    /([A-Z][a-z]+\\s+\\d{1,2},\\s+\\d{4})/g,
    "January 1, 2030"
  );
  output = output.replace(
    /name="_csrf" value="[^"]+"/g,
    `name="_csrf" value="${SAMPLE.csrf}"`
  );
  output = output.replace(
    /src="data:image\/[a-zA-Z]+;base64,[^"]+"/g,
    `src="${SAMPLE.pixel}"`
  );

  return output;
};

const refreshFixtures = async () => {
  await mkdir(TARGET_DIR, { recursive: true });

  for (const file of FIXTURES) {
    const sourcePath = join(SOURCE_DIR, file);
    const targetPath = join(TARGET_DIR, file);
    const html = await readFile(sourcePath, "utf-8");
    const sanitized = sanitizeHtml(html);
    await writeFile(targetPath, sanitized, "utf-8");
    process.stdout.write(`Updated fixture: ${targetPath}\n`);
  }
};

refreshFixtures().catch((error) => {
  console.error(error);
  process.exit(1);
});
