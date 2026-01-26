# evisa-flow agent notes

## Purpose
- Automates the GOV.UK eVisa flow to download the PDF and extract the share code.

## Entrypoints
- Library: `src/index.ts` (exports `EVisaFlow` and types).
- CLI: `src/cli.ts` → `bin/evisa-flow.js` (runs `dist/cli.js`).

## Key modules
- Flow orchestration: `src/evisa-flow.ts`, `src/core/step-runner.ts`.
- Steps: `src/steps/*`.
- Selectors/headings: `src/utils/selectors.ts`.

## Common commands
- Build: `make build`
- Run CLI: `npx evisa-flow`
- Debug flow (headed): `make debug-flow`
- Snapshots: `make snapshots`
- Fixtures (sanitize debug HTML): `make fixtures`
- Test steps: `make test-steps`
- Lint: `make lint`
- Typecheck: `make typecheck`

## Data safety
- Do not commit personal data. Use sample values in code/config.
- `scripts/debug-flow.js` is gitignored for local credentials.
- `downloads/debug/*.html` is gitignored. Copy/sanitize snapshots into `tests/fixtures/`.
- To refresh fixtures after updating snapshots:
  - Capture new HTML in `downloads/debug/`
  - Run `make fixtures`
  - Commit `tests/fixtures/*.html`

## PDF filename format
- Default output: `EVISA_{Surname}_{Name}_{YYYY-MM-DD}.pdf`
- `options.outputFile` overrides the name as a literal string (no templating).

## HTTP-only feasibility (no Playwright)
- Feasible but high-risk: the flow relies on session cookies, CSRF tokens, and dynamic JavaScript.
- Reverse-engineering requests would be brittle and likely to break when GOV.UK changes.
- Recommendation: keep Playwright for reliability and easier maintenance.

## Release notes
- License is MIT.
- CI runs lint, typecheck, build, and tests.
- CD uses npm OIDC trusted publishing (no NPM_TOKEN) and pushes a Docker image on tags/releases.

## GitHub go-live checklist
- Verify README examples and config sample.
- Ensure fixtures are sanitized and downloads/debug is ignored.
- Provide a minimal demo screenshot/gif (no personal data).
- Add security/privacy note (no data persisted beyond output file).
