# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

eVisaFlow automates the GOV.UK eVisa flow using Playwright browser automation to download the eVisa PDF and extract the share code. It's published as both an npm package and a Docker image. Written in TypeScript, built with tsup, tested with Node's built-in test runner.

## Commands

```bash
make build          # Build (tsup → dist/)
make lint           # ESLint with zero warnings
make typecheck      # tsc --noEmit
make test           # Build + node --test (runs tests/steps.test.js)
make dev            # Build with --watch
make debug-flow     # Headed browser run (requires scripts/debug-flow.js, gitignored)
make snapshots      # Capture page snapshots
make fixtures       # Sanitize debug HTML → tests/fixtures/
```

`npm test` builds first then runs tests. There is no separate test command — build is a prerequisite.

## Architecture

**Dual entry points:**
- Library: `src/index.ts` → exports `EVisaFlow` class and types
- CLI: `src/cli.ts` → `bin/evisa-flow.js` (uses commander + prompts)

**Step-based flow engine:** The core pattern is a sequential step runner that loops through 11 page steps. Each step implements `detect()` → `execute()` → `validate()`.

- `src/evisa-flow.ts` — Orchestrator: creates steps, launches browser, runs StepRunner
- `src/core/step-runner.ts` — Execution loop: detect current page → execute matching step → repeat (max 30 iterations)
- `src/core/page-detector.ts` — Iterates steps, returns first whose `detect()` matches
- `src/core/browser.ts` — Playwright chromium launcher wrapper
- `src/steps/base-step.ts` — Base class with helpers (`heading()`, `hasHeading()`, `waitForElement()`, `safeClick()`)
- `src/steps/*.ts` — 11 steps in order: entry-page → document-type → document-number → date-of-birth → two-factor-method → two-factor-code → prove-status → purpose-selection → confirmation → summary → download-pdf

**Supporting modules:**
- `src/utils/selectors.ts` — All DOM selectors and heading strings used for page detection and interaction
- `src/utils/logger.ts` — Pino-based structured logger
- `src/errors/index.ts` — Custom error hierarchy (PageDetectionError, SelectorNotFoundError, TwoFactorTimeoutError, AuthenticationError, SessionExpiredError)
- `src/config.ts` — Zod schema for config file validation
- `src/types.ts` — All TypeScript types (Credentials, AuthMethod, Purpose, RunOptions, StepContext, etc.)

## Testing

Tests verify step detection against sanitized HTML fixtures. Each fixture in `tests/fixtures/` corresponds to a page in the flow. To add/update fixtures:

1. Capture HTML in `downloads/debug/` via `make debug-flow`
2. Run `make fixtures` to sanitize personal data → sample values
3. Commit the updated `tests/fixtures/*.html`

## Data Safety

- Never commit personal data — use sample values only
- `scripts/debug-flow.js`, `downloads/`, `config.json` are gitignored
- Fixtures must be sanitized before committing (names, dates, CSRF tokens replaced with sample data)

## Key Types

- `AuthMethod`: union of passport / nationalId / brc / ukvi (each with different ID fields)
- `Purpose`: `"right_to_work" | "right_to_rent" | "immigration_status_other"`
- `TwoFactorMethod`: `"sms" | "email"`
- PDF filename default: `EVISA_{Surname}_{Name}_{YYYY-MM-DD}.pdf`

## CI/CD

- CI: lint → typecheck → build → test (Ubuntu, Node 20)
- Release: triggered by `v*` tags — publishes to npm via OIDC trusted publishing (no NPM_TOKEN) and pushes Docker image to GHCR
