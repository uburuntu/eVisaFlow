# Shared protocol agent notes

## Ownership
- `packages/protocol` is the Playwright-free workspace consumed by Expo.
- Canonical source lives in the repository root at `src/protocol/`; this package's
  `tsconfig.json` compiles that source into `dist/`.
- Do not create duplicate schema/type sources here and do not hand-edit `dist/`.

## Contract invariants
- Every public request, response, event, profile, challenge, artifact, and error field
  needs a Zod runtime schema plus an exported TypeScript type.
- Preserve platform-neutral values: no Node.js buffers, Playwright objects, filesystem
  paths, React Native classes, or transport-specific identifiers.
- Sensitive values may exist only where required by an active request. Never add them
  to public errors, event messages, URLs, logs, or diagnostics metadata.
- Profile authority is one of `self`, `parent_or_guardian`, or `authorised_proxy`.
- Mobile purposes are `right_to_work`, `right_to_rent`, and
  `immigration_status_other`.
- Public run states are `queued`, `running`, `awaiting_2fa`, `packaging`, `succeeded`,
  `partial_success`, `failed`, `cancelled`, `interrupted`, and `expired`.
- Artifact kinds are `evisa_pdf`, `checker_html`, and `checker_pdf`; descriptors carry
  UUID, filename, MIME type, byte length, and lowercase SHA-256.
- `validUntil` accepts either `YYYY-MM-DD` or an ISO date-time. Use
  `formatShareCodeValidUntil` and `shareCodeExpiryDeadlineMs` so date-only values stay
  calendar-stable and remain valid through the stated day.
- A mobile run uses the caller's `clientRunId` as its durable run ID/idempotency key.

## Change procedure
- Edit `src/protocol/schemas.ts`, `types.ts`, exports, and shared date helpers together.
- Add/update protocol tests for valid and invalid runtime payloads and timezone edge
  cases.
- Run `pnpm run build:protocol` and `pnpm run typecheck:protocol`.
- Then typecheck both consumers: `pnpm run typecheck:service` and
  `pnpm run typecheck:mobile`.
- Treat incompatible schema tightening as an API migration; coordinate app and service
  rollout rather than changing one side silently.
