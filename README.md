# evisa-flow

Automate the GOV.UK eVisa flow to create a share code, download the source PDF,
and optionally capture the public status-check artifacts that border or travel staff often ask to see.

**[Try the Telegram Bot](https://t.me/eVisaFlowBot)** — manage share codes for your whole family, no setup required. Add up to 6 family members, get share codes on demand or on a 30-day schedule, with PDFs and status-check artifacts delivered straight to Telegram.

## Install

```bash
corepack enable
pnpm install
pnpm exec playwright install chromium
```

## CLI

```bash
# Interactive
npx evisa-flow

# Options
npx evisa-flow \
  --document-type passport \
  --document-number 123456789 \
  --dob 1980-03-31 \
  --two-factor sms \
  --output ./evisa.pdf \
  --verbose

# Share-code only
npx evisa-flow --no-pdf

# Also capture the public status-check HTML page and PDF
npx evisa-flow --checker --config ./config.json

# Config file
npx evisa-flow --config ./config.json
```

## Library

```typescript
import { EVisaClient } from "evisa-flow";

const client = new EVisaClient({
  browser: { headless: true },
  artifacts: {
    pdf: { directory: "./downloads" },
    checker: {
      html: { directory: "./downloads" },
      pdf: { directory: "./downloads" },
    },
    diagnostics: { mode: "off" },
  },
});

const result = await client.createShareCode({
  applicant: {
    identityDocument: { type: "passport", number: "123456789" },
    dateOfBirth: "1980-03-31",
  },
  purpose: "immigration_status_other",
  challengePreference: { deliveryMethod: "sms" },
  onChallenge: async (_challenge, _ctx) => ({ code: "123456" }),
});

// {
//   shareCode: string,
//   validUntil?: "YYYY-MM-DD",
//   pdf?: { kind, ... },
//   checker?: { html?: { kind, ... }, pdf?: { kind, ... }, summary?: ... }
// }
```

PDF output is enabled by default and saved to disk. Set `artifacts.pdf` to
`false` to stop after the share code is parsed, or use in-memory bytes when you
do not need a file. Checker artifacts can use bytes too; the checker HTML is
standalone and inlines images/styles by default.

```typescript
const client = new EVisaClient({
  artifacts: {
    pdf: { mode: "bytes", maxBytes: 10 * 1024 * 1024 },
    checker: {
      html: { mode: "bytes", maxBytes: 20 * 1024 * 1024 },
      pdf: { mode: "bytes", maxBytes: 10 * 1024 * 1024 },
    },
  },
});

const result = await client.createShareCode(request);
if (result.pdf?.kind === "bytes") {
  await sendSomewhere(result.pdf.bytes, result.pdf.filename);
}
if (result.checker?.html?.kind === "bytes") {
  await sendSomewhere(result.checker.html.bytes, result.checker.html.filename);
}
```

PDF `maxBytes` defaults to 10 MiB in bytes mode. Checker HTML defaults to 20 MiB.
Downloaded PDFs are validated before they are returned or written, so an HTML
error page cannot silently become a `.pdf` artifact.

You can also verify an existing share code without creating a new one:

```typescript
const result = await client.verifyShareCode({
  shareCode: "ABC DEF 123",
  dateOfBirth: "1980-03-31",
  checkDetails: {
    jobTitle: "Traveller",
    organisation: "Self",
    purpose: "travel",
  },
});
```

## Parallel Usage

This library is safe to run in parallel as long as each run writes to its own output location.

- Use a unique `artifacts.pdf.directory` per run, or set `artifacts.pdf.path`.
- Use `artifacts.pdf.mode: "bytes"` when the caller can consume the PDF directly; `path` and `directory` only apply to file mode.
- Use `artifacts.checker.html.mode: "bytes"` and
  `artifacts.checker.pdf.mode: "bytes"` for Telegram/email integrations that do
  not need temporary files.
- Avoid sharing `browser.userDataDir` across concurrent runs.

## Privacy & Security

- No personal data is persisted beyond requested artifacts by default.
- Checker HTML/PDF artifacts can include the profile photo and immigration status
  summary. Treat them like the original eVisa PDF.
- Standalone checker HTML strips scripts, form actions, hidden/session fields, and
  sensitive auth query parameters, but it still contains the visible status data.
- Diagnostics are off by default. `diagnostics.mode: "sanitized_on_failure"`
  captures sanitized page snapshots only when a run fails. `diagnostics.mode:
  "raw"` may write personal data and session HTML.
- Do not commit real credentials, diagnostics, or downloaded files.
- For security reporting, see `SECURITY.md`.

## Config

Create `config.json`:

```json
{
  "applicant": {
    "identityDocument": { "type": "passport", "number": "123456789" },
    "dateOfBirth": "1980-03-31"
  },
  "purpose": "immigration_status_other",
  "challengePreference": { "deliveryMethod": "sms" },
  "checkDetails": {
    "jobTitle": "Traveller",
    "organisation": "Self",
    "purpose": "travel"
  },
  "browser": { "headless": true },
  "artifacts": {
    "pdf": { "directory": "./downloads" },
    "checker": {
      "html": {
        "directory": "./downloads",
        "inlineImages": true,
        "inlineStyles": true
      },
      "pdf": { "directory": "./downloads" }
    },
    "diagnostics": { "mode": "off" }
  }
}
```

## Dev

```bash
make validate
make build
make debug-flow
make smoke
make snapshots
make fixtures
```
