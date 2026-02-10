# evisa-flow

Automate the GOV.UK eVisa flow to download the PDF and extract the share code.

**[Try the Telegram Bot](https://t.me/eVisaFlowBot)** — manage share codes for your whole family, no setup required. Add up to 6 family members, get share codes on demand or on a 30-day schedule, with PDFs delivered straight to Telegram.

## Install

```bash
npm install
npx playwright install
```

## CLI

```bash
# Interactive
npx evisa-flow

# Options
npx evisa-flow \
  --auth-type passport \
  --passport-number 123456789 \
  --dob 31-03-1980 \
  --two-factor sms \
  --output ./evisa.pdf \
  --verbose

# Config file
npx evisa-flow --config ./config.json
```

## Library

```typescript
import { EVisaFlow } from "evisa-flow";

const flow = new EVisaFlow({
  credentials: {
    auth: { type: "passport", passportNumber: "123456789" },
    dateOfBirth: { day: 31, month: 3, year: 1980 },
    preferredTwoFactorMethod: "sms",
  },
  onTwoFactorRequired: async () => "123456",
  options: {
    headless: true,
    verbose: true,
    screenshotOnError: true,
    outputDir: "./downloads",
  },
});

const result = await flow.run();
// { pdfPath: string, shareCode: string, validUntil?: Date }
```

## Parallel usage

This library is safe to run in parallel as long as each run writes to its own
output location. The default PDF name is deterministic, so concurrent runs for the same person and date can overwrite each other.

- Use a unique `options.outputDir` per run, or set `options.outputFile`.
- Avoid sharing `options.userDataDir` across concurrent runs.

## Privacy & security

- No data is persisted beyond the output PDF and optional debug artifacts.
- Do not commit real credentials or downloaded files.
- For security reporting, see `SECURITY.md`.

## Config

Create `config.json`:

```json
{
  "credentials": {
    "auth": { "type": "passport", "passportNumber": "123456789" },
    "dateOfBirth": { "day": 31, "month": 3, "year": 1980 },
    "preferredTwoFactorMethod": "sms"
  },
  "purpose": "immigration_status_other",
  "options": {
    "headless": true,
    "verbose": false,
    "screenshotOnError": true,
    "outputDir": "./downloads"
  }
}
```

## Dev

```bash
make build
make debug-flow
make snapshots
make sanitize
make test-steps
```
