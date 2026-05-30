# eVisaFlow

Automate the GOV.UK eVisa journey to create a share code, download the eVisa
PDF, and optionally capture the public checker page/PDF that staff may ask to
see.

This is an unofficial tool for people who already have permission to access the
immigration record they are using.

**Want no setup?** Try the Telegram bot: [@eVisaFlowBot](https://t.me/eVisaFlowBot).
It can manage up to 6 family members, refresh share codes on demand or on a
schedule, and send PDFs/checker artifacts back in Telegram.

## Quick Start

Requirements: Node.js 22+ and Playwright Chromium.

```bash
npx evisa-flow
```

If Chromium is not installed yet:

```bash
npx playwright install chromium
```

For repeated use or library integration:

```bash
npm install evisa-flow
npx playwright install chromium
```

## CLI

Interactive mode is the safest default because your document number does not end
up in shell history:

```bash
npx evisa-flow
```

Common options:

```bash
npx evisa-flow \
  --document-type passport \
  --document-number 123456789 \
  --dob 1980-03-31 \
  --two-factor sms \
  --output ./downloads/evisa.pdf

# Create the share code without downloading the eVisa PDF
npx evisa-flow --no-pdf

# Also capture the public checker HTML/PDF artifacts
npx evisa-flow --checker --config ./config.json
```

The CLI prints a JSON result. File artifacts are written to `downloads/` unless
you pass `--output`, `--output-dir`, or configure artifact paths.

## Config File

Create `config.json` when you do not want to repeat flags:

```json
{
  "applicant": {
    "identityDocument": { "type": "passport", "number": "123456789" },
    "dateOfBirth": "1980-03-31"
  },
  "purpose": "immigration_status_other",
  "challengePreference": { "deliveryMethod": "sms" },
  "artifacts": {
    "pdf": { "mode": "file", "directory": "./downloads" },
    "checker": {
      "html": { "mode": "file", "directory": "./downloads" },
      "pdf": { "mode": "file", "directory": "./downloads" }
    },
    "diagnostics": { "mode": "off" }
  }
}
```

See [config.sample.json](./config.sample.json) for the full shape, including
checker details and debug diagnostics.

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
  },
});

const result = await client.createShareCode({
  applicant: {
    identityDocument: { type: "passport", number: "123456789" },
    dateOfBirth: "1980-03-31",
  },
  purpose: "immigration_status_other",
  challengePreference: { deliveryMethod: "sms" },
  onChallenge: async () => ({ code: "123456" }),
});

console.log(result.shareCode, result.validUntil, result.pdf);
```

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

For integrations that should not write temporary files, use bytes mode:

```typescript
const client = new EVisaClient({
  artifacts: {
    pdf: { mode: "bytes" },
    checker: {
      html: { mode: "bytes" },
      pdf: { mode: "bytes" },
    },
  },
});
```

PDF downloads are validated before they are returned or written, so an HTML error
page cannot silently become a `.pdf` artifact.

## Privacy And Safety

- eVisa PDFs, checker PDFs, and checker HTML can contain personal data, profile
  photos, and immigration status details. Treat them as sensitive documents.
- Standalone checker HTML removes scripts, form actions, hidden/session fields,
  and sensitive auth query parameters, but it still contains visible status data.
- Diagnostics are off by default. `sanitized_on_failure` captures sanitized
  snapshots only when a run fails. `raw` may write personal data and session HTML.
- Do not commit real credentials, diagnostics, downloaded PDFs, or checker
  artifacts.
- Security reports should use GitHub Security Advisories. See
  [SECURITY.md](./SECURITY.md).

## Parallel Usage

Parallel runs are supported when each run has its own output location.

- Use a unique artifact directory or explicit artifact path per run.
- Use bytes mode when the caller can consume files directly.
- Do not share `browser.userDataDir` across concurrent runs.

## Development

```bash
corepack enable
pnpm install
pnpm exec playwright install chromium

make validate
make smoke
make snapshots
make fixtures
```

## Self-host the web app

The [service/](./service) directory is a self-hostable, web-first app (Fastify
API + SSE + a built Astro/React frontend) with an **opt-in** Telegram bot — it
runs with no Telegram account. One command brings up a bundled Postgres plus the
app:

```bash
cp service/.env.selfhost.example service/.env   # then set SESSION_SECRET
docker compose -f service/docker-compose.selfhost.yml up
# open http://localhost:8080
```

See the [self-host quickstart](./service/README.md#self-host-quickstart-one-command-web-first)
for details, including how to enable the Telegram bot.
