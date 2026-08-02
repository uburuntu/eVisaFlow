# eVisaFlow mobile agent notes

## Purpose and audience
- This Expo/React Native app gives users dependable offline access to eVisa proofs,
  share codes, and printable files. Design first for a stressed or older user with a
  poor connection who may have had initial setup completed by someone they trust.
- Saved documents are the first screen and primary workflow. People/profiles are the
  organisation layer, not a "family app" proposition.
- Avoid user-facing "family" wording. Existing `family-*` test IDs are legacy stable
  automation identifiers and are not display copy.
- Keep language direct, calm, and explicit about what is offline, encrypted, expiring,
  unofficial, or temporarily processed.

## Runtime and navigation
- Current stack: Expo SDK 56, React Native 0.85, React 19, Expo Router, TypeScript,
  Supabase anonymous Auth, and Zod contracts from `@evisa-flow/protocol`.
- Supported baseline: iOS 16.4+ and Android 9/API 28+.
- `app/_layout.tsx` owns providers, navigation, status bar, bottom safe-area framing,
  service bootstrap, and the app-switcher privacy cover.
- `app/index.tsx` is the offline-vault dashboard.
- `app/profiles/*` owns encrypted profile creation/edit/delete.
- `app/runs/new.tsx` confirms purpose and authority before a live run.
- `app/runs/[id].tsx` owns run polling, OTP entry, cancellation, result claiming, and
  offline persistence.
- `app/documents/[id].tsx` owns share-code copy and artifact print/share actions.
- `app/settings.tsx` owns privacy disclosure and remote-plus-local deletion.

## Product behavior already implemented
- First launch requires acknowledgement that eVisaFlow is unofficial and that the
  user is authorised to manage every added person.
- Profiles capture display name, identity document type/number, date of birth,
  preferred SMS/email security-code method, and authority basis (`self`,
  `parent_or_guardian`, or `authorised_proxy`).
- The app supports passport, national ID, BRC, and UKVI account-number identities.
- A user selects and confirms `right_to_work`, `right_to_rent`, or
  `immigration_status_other` for each run.
- The dashboard, profiles, previous results, and active-run pointer load without a
  network connection. Service connection failure during startup is expected and must
  not block the vault.
- Successful results expose the share code, expiry, encrypted artifacts, native
  sharing, PDF printing, and copying. Share-code date-only expiries use the shared
  timezone-stable formatter.
- Profile deletion is blocked while that profile has an active run; otherwise it also
  removes the person's local results and queues an opaque server-slot tombstone for
  the next successful connection.
- Delete All is remote-first: it cancels/deletes the anonymous service account, signs
  out, then crypto-erases the local session and vault. If remote deletion fails, local
  data remains intact and the user is asked to retry.

## Service modes
- `EXPO_PUBLIC_EVISAFLOW_DEMO_MODE=true` selects the deterministic fictional client.
  CI and App Review builds use this mode and never contact GOV.UK.
- Live mode requires all three public values:
  `EXPO_PUBLIC_EVISAFLOW_API_URL`, `EXPO_PUBLIC_SUPABASE_URL`, and
  `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
- Missing live configuration selects `unconfigured`; do not silently fall back to a
  production-looking fake result.
- Every `EXPO_PUBLIC_*` value is compiled into the app. Never place a Supabase
  service-role key, server encryption key, user secret, or private endpoint there.
- Live auth is a silent Supabase anonymous session. There is no visible login.

## Run and entitlement model
- The client creates the run UUID; the API uses it as the run ID/idempotency key.
- Only one local active run is tracked. The service and database also enforce one
  active run per anonymous user.
- The app currently polls `GET /v1/runs/:id` every 1.2 seconds; the API's SSE endpoint
  is not yet consumed by the app. Treat the snapshot endpoint as authoritative.
- OTP input accepts 4-8 digits. Never persist, log, prefill, or include a real OTP in
  analytics or diagnostics.
- On success, claim once, download each artifact, verify byte length and SHA-256,
  encrypt locally, update the manifest, and only then navigate to the saved proof.
- Failed, cancelled, interrupted, and partial results do not consume free allowance.
  A complete claimed result does.
- Current service limits are one profile and three complete claimed results for free;
  `evisaflow_pro` permits six profiles and unlimited results. The backend enforcement
  and UI states exist, but purchase and restore flows do not.

## Local security invariants
- `src/vault/vault.ts` is the source of truth for the versioned vault document.
- Profiles, result metadata, active-run state, tombstones, and each artifact are
  AES-256-GCM encrypted. Auth-session storage is encrypted separately.
- Per-installation AES keys live in SecureStore with
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; Android backup is disabled. Never add a plaintext
  AsyncStorage fallback.
- Vault and session writes use temporary files followed by an atomic move.
- The vault accepts at most six profiles, 100 saved results, one active run, and 100
  tombstones. Change these only with schema migration and recovery tests.
- Downloaded artifact byte length and SHA-256 must match the server descriptor before
  local encryption.
- Decrypt only into `Paths.cache` for a single print/share action and delete the
  plaintext file in `finally`. Printing is PDF-only.
- Missing key plus existing ciphertext is an explicit unrecoverable-vault state. Offer
  a reset; never weaken encryption or invent a recovery key.
- Do not add advertising SDKs or third-party behavioral analytics. Sensitive values
  must never enter logs, crash metadata, URLs, clipboard telemetry, or support bundles.

## UI and accessibility invariants
- Use the established restrained green/neutral system, Lucide icons, 8px-or-less card
  radii, and full-width work surfaces. Do not turn the app into a marketing landing
  page.
- Keep the official-service link visible in onboarding, the dashboard, settings, and
  recoverable failure paths.
- All app text goes through `AppText` unless a native control requires otherwise. The
  supported font multiplier ceiling is 2.0.
- Preserve safe-area handling around Android's transparent system bars and iOS home
  indicator. Test the top and scrolled controls at 200% text after layout changes.
- Stable icon buttons need accessibility labels and stable dimensions. Primary flows
  need durable test IDs because Maestro operates through the accessibility tree.
- The app-switcher privacy cover must remain opaque whenever the app is not active.

## Development and validation
- Start Metro: `make mobile`.
- Run iOS: `make mobile-ios` or
  `make mobile-ios-device IOS_DEVICE="iPhone 17 Pro"`.
- Generate/open Xcode: `make mobile-ios-xcode`.
- Typecheck: `pnpm run typecheck:mobile`.
- Validate Expo dependency alignment: `pnpm run check:mobile`.
- Full repository checks: `make validate`.
- Release black-box tests: `make mobile-e2e-ios` and `make mobile-e2e-android`.
- Use native development/release builds for security and E2E work; Expo Go is only an
  iteration aid.
- Keep all package/network CLI calls unproxied as specified in the root `AGENTS.md`.

## Not implemented yet
- RevenueCat/StoreKit/Google Play Billing purchase and restore flows.
- Local expiry reminders or notification scheduling.
- Optional biometric vault locking.
- App Attest, DeviceCheck, Play Integrity, or equivalent mutation attestation.
- Multi-person sequential batch generation.
- A built-in hardened HTML viewer; checker HTML is currently stored and shareable.
- Production VoiceOver/TalkBack and print/share verification on physical devices.
- Do not imply any of these exist in UI copy, store materials, or release notes.
