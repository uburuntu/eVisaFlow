# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

eVisaFlow automates the GOV.UK eVisa flow using Playwright browser automation to download the eVisa PDF and extract the share code. It's published as both an npm package and a Docker image. Written in TypeScript, built with tsup, tested with Node's built-in test runner.

## Commands

```bash
make build          # Build (tsup → dist/)
make lint           # Biome CI with zero warnings
make typecheck      # tsc --noEmit
make test           # Build + node --test for library and service tests
make validate       # Lint + typecheck + build + test + pack dry-run + audit
make dev            # Build with --watch
make debug-flow     # Headed browser run (requires scripts/debug-flow.js, gitignored)
make snapshots      # Capture page snapshots
make fixtures       # Sanitize debug HTML → tests/fixtures/
```

`npm test` builds first then runs tests. There is no separate test command — build is a prerequisite.

## Architecture

**Dual entry points:**
- Library: `src/index.ts` → exports `EVisaClient`, errors, and public domain types
- CLI: `src/cli.ts` → `bin/evisa-flow.js` (uses commander + prompts)

**Classified step engine:** The public API accepts one domain request (`EVisaClient.createShareCode`). Internally, each browser page is reduced to a `PageSnapshot`, classified into a stable `PageKind`, then routed to one existing step action.

- `src/evisa-client.ts` — Public orchestrator: creates steps, launches browser, maps domain API to internal runner
- `src/core/page-snapshot.ts` — Captures normalized page state for classification and sanitized diagnostics
- `src/core/page-classifier.ts` — Classifies snapshots into stable page kinds and phases
- `src/core/step-runner.ts` — Execution loop: classify current page → execute matching step → repeat (max 30 iterations)
- `src/core/browser.ts` — Playwright chromium launcher wrapper
- `src/steps/base-step.ts` — Base class with helpers (`heading()`, `hasHeading()`, `waitForElement()`, `safeClick()`)
- `src/steps/*.ts` — 11 steps in order: entry-page → document-type → document-number → date-of-birth → two-factor-method → two-factor-code → prove-status → purpose-selection → confirmation → summary → download-pdf

**Supporting modules:**
- `src/utils/selectors.ts` — All DOM selectors and heading strings used for page detection and interaction
- `src/utils/logger.ts` — Pino-based structured logger
- `src/errors/index.ts` — Custom error hierarchy with stable `code`, retryability, phase, page kind, and artifact refs
- `src/config.ts` — Zod schema for config file validation
- `src/types.ts` — Public TypeScript types only
- `src/core/internal-types.ts` — Internal legacy step contracts

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

- `Applicant`: identity document plus date of birth for `EVisaClient.createShareCode`
- `Purpose`: `"right_to_work" | "right_to_rent" | "immigration_status_other"`
- `TwoFactorMethod`: `"sms" | "email"`
- PDF filename default: `EVISA_{Surname}_{Name}_{YYYY-MM-DD}.pdf`

## CI/CD

- **CI** (`.github/workflows/ci.yml`, Ubuntu, Node from `.node-version`): lint → typecheck (lib + service) → typecheck web (`astro check`) → build (lib + service + **web app**) → run DB migrations → test (lib + service) → test web (vitest) → pack dry-run → audit. A throwaway `postgres:16` service container provides `DATABASE_URL`, so the DB-gated `db`/`migrate` tests actually run; it is never a managed/production database. The `build` step builds the frontend (`build` = `build:service` + `build:web`), and the explicit web `check`/`test` steps mean a frontend break fails CI. A `docker` job builds the CLI image and the combined `service/Dockerfile` image and smoke-tests its `/ready` health endpoint.
- **Release** (`.github/workflows/release.yml`, triggered by `v*` tags): publishes the `evisa-flow` library to npm via OIDC trusted publishing (no NPM_TOKEN) and pushes both the CLI image and the combined web+service image (`ghcr.io/uburuntu/evisaflow:service-<tag>`) to GHCR.
- **Deploy** (`.github/workflows/deploy.yml`, on push to `main` touching `service/**`, `web/**`, `src/**`, the Dockerfiles, or the workflows): runs CI, builds/pushes the **combined web+service image** to GHCR, then SSHes to the host and does a preflight (DB always; Telegram only when `ENABLE_BOT`) → explicit idempotent DB migration → container swap → 45-iteration `/ready` health gate (Fastify `/ready` on `PORT`) → rollback on failure. Runtime config is supplied via the `DOTENV_FILE` secret (never baked into the image); it must include `DATABASE_URL` (Postgres — replaces the retired `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`), `SESSION_SECRET`, `PUBLIC_BASE_URL`, and optionally `PORT`. For a bot deployment it must also set `ENABLE_BOT=true`, `TELEGRAM_BOT_TOKEN`, and `ENCRYPTION_KEY`.

## Self-host web app (`service/` + `web/`)

`service/` is a self-hostable, **web-first** app (Fastify API + SSE + the built Astro/React frontend from `web/`, on one in-process run engine driving Playwright). The **Telegram bot is opt-in** (`ENABLE_BOT`, default off) — a pure-web self-host runs with no Telegram account.

- One-command self-host: `docker compose -f service/docker-compose.selfhost.yml up` brings up a bundled `postgres:16` + the app on one port, applies migrations on boot, and serves the web app + API. Only `SESSION_SECRET` must be set (`service/.env.selfhost.example`).
- DB is portable Postgres via `DATABASE_URL` (Drizzle + `pg`); the migration runner (`service/src/db/migrate.ts`, migrations `001`–`006`) is baseline-safe and idempotent and applies the schema on start — no manual SQL, no Supabase SDK.
- `DEPLOYMENT_MODE` (`selfhost` default | `cloud`) gates later cloud-only wiring; `ENABLE_BOT` toggles the Telegram channel (and makes `TELEGRAM_BOT_TOKEN` + `ENCRYPTION_KEY` required). Web runs are client-custody (E2EE, sealed to the user's key) and never use `ENCRYPTION_KEY`; only the bot uses server-custody AES.
- See `service/README.md` for the full quickstart, env table, and the bot-only / external-DB (`service/docker-compose.yml`) path.
