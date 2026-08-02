# evisa-flow agent notes

## Product boundary
- The core library automates the GOV.UK eVisa flow to obtain a share code and its
  supporting artifacts.
- The mobile product is an offline eVisa document vault. Fast access to a previously
  generated proof is the primary value; managing several authorised people multiplies
  that value but is not the product identity.
- eVisaFlow is independent and unofficial. Never imply Home Office, UKVI, GOV.UK, or
  UK Government affiliation. Do not use crowns, government logos, or GOV.UK visual
  branding. Always retain a clear route to the free official GOV.UK service.
- Playwright runs only in Node.js service workers. Do not add Playwright, browser
  automation, downloaded automation code, or hidden WebView automation to the mobile
  binary.
- Public paid launch remains gated by the decisions in
  `docs/mobile-app-plan.md`; do not describe the apps as approved or production-ready
  while those gates remain open.

## Workspace ownership
- Core library and CLI: `src/`, `bin/`, and `tests/`.
- Shared transport contracts: canonical source in `src/protocol/`, compiled mobile
  workspace in `packages/protocol/`.
- Telegram transport, Playwright worker, and mobile HTTP API: `service/`.
- Expo Android/iOS client: `apps/mobile/`.
- Mobile black-box tests: `apps/mobile/e2e/` plus the root
  `scripts/mobile-e2e-*.sh` runners.
- Hosted checks and persistent PR visuals: `.github/workflows/`.
- Read the nearest nested `AGENTS.md` before changing one of those areas.

## Entrypoints
- Library: `src/index.ts` exports `EVisaClient` and public domain types.
- CLI: `src/cli.ts` -> `bin/evisa-flow.js` -> `dist/cli.js`.
- Combined service: `service/src/index.ts`.
- Mobile-API-only process: `service/src/api/index.ts`.
- Expo Router root: `apps/mobile/app/_layout.tsx`.

## Core modules
- Flow orchestration: `src/evisa-client.ts`, `src/core/step-runner.ts`.
- Page classification: `src/core/page-snapshot.ts`, `src/core/page-classifier.ts`.
- Steps: `src/steps/*`.
- Selectors/headings: `src/utils/selectors.ts`.
- Shared protocol: `src/protocol/*`.

## Common commands
- Install: `make install`
- Build: `make build`
- Run CLI: `npx evisa-flow`
- Validate all static checks, builds, tests, package output, and audit: `make validate`
- Tests: `make test`
- Lint: `make lint`
- Typecheck: `make typecheck`
- Debug flow (headed): `make debug-flow`
- Live smoke check: `make smoke`
- Snapshots: `make snapshots`
- Fixtures: `make fixtures`
- Start Expo: `make mobile`
- iOS simulator build: `make mobile-ios-device IOS_DEVICE="iPhone 17 Pro"`
- Complete release E2E: `make mobile-e2e-ios` and `make mobile-e2e-android`

The Make targets remove `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, and `https_proxy`.
Prefix direct network/package CLI commands with
`env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy` as well.

## Data safety
- Never commit or publish personal data, live identity details, OTPs, share codes,
  authentication tokens, or unsanitized GOV.UK pages.
- Use fictional values in code, fixtures, screenshots, recordings, CI, and App Review
  mode.
- `scripts/debug-flow.example.js` is tracked; `scripts/debug-flow.js` is ignored and
  may contain local credentials.
- `downloads/debug/*.html` is ignored. Sanitize captured HTML through `make fixtures`
  before adding anything under `tests/fixtures/`.
- Logs and public errors must exclude document numbers, dates of birth, OTPs, share
  codes, artifact contents, and sensitive URLs or query strings.

## Contract rules
- Add or change transport fields in `src/protocol/` first. Every public field needs a
  runtime Zod schema, an exported TypeScript type, and a protocol test.
- Keep `packages/protocol` free of Node.js and Playwright imports so React Native can
  consume it.
- A share-code `validUntil` may be a calendar date (`YYYY-MM-DD`) or ISO date-time.
  Date-only values expire at the end of that UTC calendar day and must render without
  timezone drift; use the shared helpers instead of raw local `Date` formatting.
- Preserve backward compatibility for the published root `evisa-flow` API.

## Artifact rules
- Default PDF output:
  `eVisa Share Code - {Name} {Surname} - Expires {YYYY-MM-DD}.pdf`.
- In file mode, `artifacts.pdf.path` is a literal output path, not a template.
- In bytes mode, PDF output remains in memory and defaults to a 10 MiB limit.
- Mobile successful results may contain an eVisa PDF, standalone checker HTML, and
  checker PDF. Do not silently relabel generated checker artifacts as GOV.UK files.

## HTTP-only feasibility
- Direct HTTP automation is possible in theory but remains high-risk because the flow
  relies on session cookies, CSRF tokens, and dynamic JavaScript.
- Keep Playwright as the supported automation engine unless a separately reviewed
  architecture explicitly replaces it.

## Mobile delivery invariant
- Every mobile-facing pull request must receive one bot-owned comment containing
  current iOS and Android core-screen screenshots, 200% text evidence, and focused
  journey videos. CI updates the comment in place from fictional release builds.
- Run local validation before spending hosted native-runner time. Do not weaken the
  dual-platform release E2E gate to make CI faster.

## Release notes
- License: MIT.
- npm publishing uses OIDC trusted publishing, not `NPM_TOKEN`.
- Container release workflows publish the CLI and service images.
- Before merging mobile work, verify the scoped `AGENTS.md` files and the remaining
  launch roadmap are still accurate.
