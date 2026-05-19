# evisa-flow

Automate the GOV.UK eVisa flow to create a share code and optionally download the PDF.

**[Try the Telegram Bot](https://t.me/eVisaFlowBot)** — manage share codes for your whole family, no setup required. Add up to 6 family members, get share codes on demand or on a 30-day schedule, with PDFs delivered straight to Telegram.

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

// { shareCode: string, validUntil?: "YYYY-MM-DD", pdf?: { kind, ... } }
```

PDF output is enabled by default and saved to disk. Set `artifacts.pdf` to `false` to stop after the share code is parsed, or use in-memory bytes when you do not need a file:

```typescript
const client = new EVisaClient({
  artifacts: {
    pdf: { mode: "bytes", maxBytes: 10 * 1024 * 1024 },
  },
});

const result = await client.createShareCode(request);
if (result.pdf?.kind === "bytes") {
  await sendSomewhere(result.pdf.bytes, result.pdf.filename);
}
```

`maxBytes` defaults to 10 MiB in bytes mode.

## Parallel Usage

This library is safe to run in parallel as long as each run writes to its own output location.

- Use a unique `artifacts.pdf.directory` per run, or set `artifacts.pdf.path`.
- Use `artifacts.pdf.mode: "bytes"` when the caller can consume the PDF directly; `path` and `directory` only apply to file mode.
- Avoid sharing `browser.userDataDir` across concurrent runs.

## Privacy & Security

- No personal data is persisted beyond requested PDF artifacts by default.
- Diagnostics are off by default. `diagnostics.mode: "raw"` may write personal data and session HTML.
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
  "browser": { "headless": true },
  "artifacts": {
    "pdf": { "directory": "./downloads" },
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
