# eVisaFlow service agent notes

## Scope and entrypoints
- This workspace contains the Telegram bot, scheduler, shared in-memory browser queue,
  Playwright runner adapter, health/readiness server, and authenticated mobile API.
- `src/index.ts` starts the combined production process.
- `src/api/index.ts` can start only the mobile API, but the current Docker Compose
  deployment runs the combined `dist/index.js` process.
- `src/runner/evisa-runner.ts` adapts the transport-neutral library flow.
- `src/runner/queue.ts` limits browser concurrency and serializes work per owner.
- `src/api/app.ts`, `mobile-store.ts`, `mobile-run-coordinator.ts`,
  `mobile-challenge-store.ts`, and `mobile-auth.ts` implement the mobile surface.

## Mobile API contract
- All `/v1` routes require a valid Supabase bearer token and return private/no-store,
  anti-sniffing, anti-framing, and no-referrer headers.
- Current public routes:
  - `GET` and `DELETE /v1/me`;
  - `PUT` and `DELETE /v1/profile-slots/:id`;
  - `POST /v1/runs` and `GET /v1/runs/:id`;
  - `GET /v1/runs/:id/events` for SSE replay/heartbeats;
  - `POST /v1/runs/:id/challenge`, `/cancel`, `/claim-result`, and
    `/claim-result/acknowledge`;
  - `GET /v1/runs/:id/artifacts/:artifactId` with the active claim token.
- Parse every body and path value with shared Zod schemas before reaching the worker.
- Errors expose stable uppercase codes, a safe message, and `retryable`; never expose
  raw upstream errors or sensitive fields.
- Keep bounded per-user rate limits on run creation, OTP submission, claims, and
  downloads. `Retry-After` is part of the 429 contract.

## Authentication and ownership
- Mobile users authenticate through Supabase anonymous Auth; only the service role
  accesses mobile database tables and the private Storage bucket.
- `mobile_profile_slots` contains opaque UUIDs, not identity details. Profile limits
  are enforced in PostgreSQL under a row lock as well as in the API/app.
- Every run, event, claim, artifact download, cancellation, and account deletion must
  be scoped to the authenticated owner.
- Deleting an account cancels active work first, removes private blobs, then deletes
  the Supabase Auth user so database rows cascade. Immediately invalidate the exact
  bearer token in `SupabaseMobileAuth`; invalidation must win over cached and in-flight
  verification so a concurrent request cannot recreate a deleted server row.

## Sensitive-data lifecycle
- Applicant requests and share-code result metadata are AES-256-GCM encrypted with
  `ENCRYPTION_KEY` before database storage.
- OTPs live only in `mobile-challenge-store.ts` memory until consumed, expired,
  superseded, cancelled, or aborted. Never persist or log them.
- Artifact plaintext is encrypted before upload to the private
  `mobile-run-artifacts` bucket. Storage objects use
  `application/octet-stream`; authenticated downloads decrypt only after claim.
- Artifact descriptors include plaintext byte length and SHA-256 for client-side
  verification. The bucket limit is 25 MiB because checker HTML may reach 20 MiB
  before AES-GCM overhead.
- Successful/partial results and artifacts expire after one hour. Cleanup runs at
  startup and every 15 minutes; run events older than 30 days are removed.
- Terminal updates clear encrypted applicant requests. Expired rows clear encrypted
  request/result and challenge metadata.
- Logs must omit identity numbers, dates of birth, OTPs, share codes, status contents,
  artifact bytes, bearer tokens, and URL query strings.

## Run semantics and monetization baseline
- The client-generated UUID is the run primary key. Duplicate creation returns the
  existing owned run; a unique partial index enforces one active run per user.
- The queue owner key serializes a mobile user's work. Default global browser
  concurrency is two and remains configurable by `QUEUE_CONCURRENCY`.
- Free users may have one active profile and three complete claimed results.
  `evisaflow_pro` permits six active profiles and unlimited results.
- Pending unclaimed complete successes reserve free allowance. Beginning a claim does
  not increment usage. Only the first atomic acknowledgement after verified device
  persistence increments usage for a `succeeded` run. Retried acknowledgements are
  idempotent. Partial, failed, cancelled, interrupted, and expired runs do not consume
  allowance.
- Packaging all three artifact kinds produces `succeeded`; fewer available artifacts
  produce `partial_success` and remain claimable without consuming free allowance.
- A maintenance flag blocks new runs while allowing existing result retrieval and
  deletion.
- The private-beta admission cap defaults to 25 runs across the service per UTC day and
  is configurable with `MOBILE_BETA_DAILY_RUN_LIMIT`; the API returns `Retry-After`
  and the official-service fallback when it is reached.

## Current durability boundary
- The queue and pending OTP broker are in-process, not PGMQ-backed. Do not describe
  them as durable or horizontally scalable.
- Mobile API startup marks every active mobile run `interrupted`, removes its sensitive
  request, and requires an explicit retry. This avoids replaying a possibly-started
  GOV.UK browser session.
- The mobile app consumes SSE while foregrounded, reconnects with `Last-Event-ID`,
  treats snapshots as authoritative, and falls back to 5-second or queued 15-second
  polling after repeated stream failures.
- A future durable worker topology must define leases, ownership, challenge routing,
  crash-before-navigation replay, crash-after-navigation interruption, and shutdown
  semantics before enabling multiple replicas.

## Database and deployment
- Apply migrations in order; mobile tables, functions, RLS, and the private bucket are
  created by `migrations/004_mobile_api.sql`, and
  `migrations/005_two_phase_mobile_claim.sql` makes result accounting acknowledge-only.
- Enable Supabase anonymous sign-ins before live mobile testing.
- Keep `SUPABASE_SERVICE_ROLE_KEY` and `ENCRYPTION_KEY` server-only.
- Compose exposes the mobile API only on host loopback. Terminate TLS at a reverse
  proxy and add proxy-level request/body limits; never expose the health port or
  private Storage bucket publicly.
- Deployment preflight and readiness must pass before replacing the container, and a
  failed replacement must roll back.

## Validation
- Typecheck/build: `pnpm run typecheck:service` and `pnpm run build:service`.
- Service tests: `node --test service/tests/*.test.js` or `make test`.
- Full gate: `make validate`.
- Keep focused tests for auth caching, owner boundaries, response headers, rate-limit
  windows, idempotency, queue cancellation/serialization, OTP expiry, encryption
  tamper detection, cleanup, account deletion, partial artifacts, and atomic claims.
- Test migration changes against disposable PostgreSQL/Supabase-compatible schemas;
  never validate destructive migrations against production first.
