# eVisaFlow Mobile Remaining Roadmap

Status: PR #4 establishes the mobile foundation. Implemented behavior is documented
as durable guidance in:

- `AGENTS.md`
- `apps/mobile/AGENTS.md`
- `apps/mobile/e2e/AGENTS.md`
- `packages/protocol/AGENTS.md`
- `service/AGENTS.md`
- `.github/AGENTS.md`

Public release status and evidence are tracked canonically in
`docs/public-launch-gates.md`. This roadmap does not override a no-go gate.

This document contains only unresolved decisions, launch gates, and future work. Do
not move an item out of this file until it is implemented and verified, then record the
result in the nearest scoped `AGENTS.md`.

## Public-launch gates

- Obtain a written Home Office or GDS position covering user-authorised automation,
  authorised proxies, adult and child accounts, downloads, paid convenience features,
  branding, app-store distribution, and acceptable request rates.
- Confirm current Apple and Google policy treatment of an unofficial app that
  facilitates access to a government immigration service. An unofficial disclaimer
  alone must not be assumed sufficient.
- Publish through a legal entity using Apple and Google organisation accounts.
- Complete a UK GDPR data-protection impact assessment and determine controller/
  processor roles, lawful bases, adult proxy consent evidence, guardian handling,
  retention, subject rights, breach response, international transfers, and whether ICO
  registration is required.
- Publish privacy, terms, support, and account-deletion web pages that match actual app
  and service behavior.
- Complete Apple's encryption export-compliance assessment before declaring an
  exemption or setting `ITSAppUsesNonExemptEncryption`.
- Apply `service/migrations/004_mobile_api.sql`, enable anonymous Auth, provision the
  private bucket, configure secrets, and put the mobile API behind a production TLS
  reverse proxy with request/body limits.
- Complete physical-device, accessibility, store-beta, and adverse-network validation
  before asking for public review.

## Decisions required before billing work

- Confirm whether the intended free allowance remains one person and three complete
  claimed results over the lifetime of an anonymous account.
- Confirm whether Pro remains six people with unlimited complete results, and whether
  GBP 3.99 monthly / GBP 24.99 yearly is appropriate after store fees, Playwright
  infrastructure cost, support cost, and policy risk.
- Decide whether payment covers only convenience features or also live automation;
  store and in-app wording must make clear that the underlying government service is
  free.
- Decide whether RevenueCat is the entitlement authority and whether the Supabase
  anonymous user ID is its App User ID.
- Define RevenueCat webhook authentication, replay protection, idempotency, grace
  periods, refunds, chargebacks, billing retry, offline entitlement cache, and database
  reconciliation.
- Resolve restore behavior. Anonymous identity makes cross-device/cross-platform
  recovery and reinstall-based lifetime limits weak without a visible account. Choose
  deliberately between that limitation, optional account linking, or a different
  entitlement model; do not add device fingerprinting by default.
- Design and test the paywall, purchase, restore, manage-subscription, expired-
  entitlement, and billing-unavailable journeys on both stores.

## Production architecture decision

The current mobile queue and OTP broker are in-process. API startup deliberately
interrupts active runs rather than replaying a possibly-started GOV.UK session. This is
a candidate for a tightly controlled single-replica beta, but it still needs an
explicit reliability decision and is not a durable or horizontally scalable worker
topology.

Before multiple replicas or meaningful paid traffic, decide whether to:

1. retain a single combined service with documented downtime/interruption behavior;
2. introduce a durable queue such as PGMQ and separate API/worker processes; or
3. use another managed queue with equivalent ownership, lease, and retry guarantees.

The chosen design must specify:

- atomic claiming and lease renewal;
- per-user serialization and global backpressure;
- crash before browser navigation versus crash after navigation;
- OTP challenge routing without persistent OTP storage;
- cancellation and shutdown behavior;
- artifact packaging idempotency;
- duplicate prevention and bounded retries;
- maintenance/kill-switch behavior;
- observability that contains no identity data;
- capacity and cost thresholds for adding workers.

Also decide whether the app should consume the existing SSE event stream or retain
1.2-second authoritative snapshot polling. Evaluate battery, network loss, proxy
behavior, resume semantics, implementation complexity, and server cost.

## Security work

- Select and integrate a supported device/app integrity mechanism for mutation
  endpoints, likely App Attest/DeviceCheck on Apple and Play Integrity on Android.
- Define behavior for unsupported, rooted/jailbroken, emulated, restored, or falsely
  rejected devices without blocking legitimate vulnerable users from their already
  saved offline documents.
- Add optional biometric vault locking only after defining key invalidation and reset
  behavior. Never introduce a weaker fallback that silently bypasses device security.
- Commission an external threat-model review covering anonymous Auth token theft,
  replay, API abuse, service-role exposure, artifact enumeration, queue denial of
  service, logs, backups, screenshots, clipboard behavior, and local temporary files.
- Decide whether a hardened in-app checker HTML viewer is needed. If added, disable
  JavaScript and network access and test hostile HTML; otherwise keep OS sharing as the
  explicit supported behavior.
- Define privacy-preserving crash and reliability telemetry, or launch without it.
  Document exactly what is collected and enforce sensitive-data scanning.

## User-value work

- Add local expiry reminders, initially 14 and 3 days before the newest result expires
  for each person and purpose. Replace superseded reminders and require no APNs/FCM.
- Design a sequential multi-person run that asks once for a confirmed purpose, remains
  recoverable between people, presents each OTP clearly, and never promises unattended
  background generation.
- Design a trusted-helper handoff for the target case: setup is completed by a relative,
  then an older user can open the correct offline proof at a border with poor or no
  connectivity. Consider a readiness check, a deliberately simple offline view, expiry
  warnings, and safe device-transfer expectations without adding cloud profile sync.
- Decide whether per-proof deletion, storage management, export, or a printable
  emergency bundle is required before beta.
- Validate the target of first useful setup within 90 seconds and a repeat generation
  path requiring no more than two taps before the GOV.UK security-code challenge.
- Finalize store name/subtitle, screenshots, onboarding disclosure, paywall text, and
  official-source attribution with policy/legal review.

## Verification and beta exit

- Run TestFlight and Google Play closed testing before public submission.
- Test VoiceOver and TalkBack with real users or qualified accessibility reviewers.
- Test maximum text, small phones, tablets, rotation policy, high contrast, reduced
  motion, keyboard behavior, and switch/external-keyboard navigation on physical
  devices.
- Verify real PDF open/print/share, HTML sharing/viewing, clipboard behavior, file
  cleanup, Keychain/Keystore persistence, uninstall/reinstall, device backup/restore,
  OS upgrade, and low-storage failure behavior.
- Exercise airplane mode, captive portal, packet loss, slow network, app background,
  process death, service restart, OTP expiry, duplicate taps, partial artifacts,
  maintenance mode, account deletion failure, and GOV.UK layout change.
- Add integration coverage for durable-queue leases and worker crashes if the
  production topology changes.
- Keep live automation creator/internal-only until written authorization is available.
- Beta exit targets:
  - no lost local proof after a successful verified save;
  - no lost active-run recovery under the supported restart model;
  - at least 99.5% crash-free sessions;
  - at least 95% app-controlled run success, excluding GOV.UK and user errors;
  - zero detected personal data in telemetry, CI media, logs, or support bundles;
  - the two-tap repeat-generation target validated with representative users.

## Explicit v1 non-goals

- Identity-document scanning or photo capture.
- Cloud profile/document sync.
- Unattended background share-code generation.
- Telegram account linking.
- Advertising SDKs or third-party behavioral analytics.
- Dynamic downloaded automation code in the mobile app.

## Recommended sequence

1. Resolve government authorization, store-policy, legal-entity, and data-protection
   questions before building paid distribution around an uncertain permission model.
2. Choose the beta production topology and deploy the existing API/migration behind
   TLS with secrets, backups, monitoring, and a kill switch.
3. Complete physical-device and accessibility validation of the free fictional/live
   beta, including the poor-connectivity handoff scenario.
4. Implement integrity controls and the approved billing/restore model with full store
   sandbox E2E.
5. Add reminders, optional biometric locking, and sequential multi-person generation
   in that order unless user research changes the priority.
6. Submit a complete fictional demo mode to both stores early. If authorization is
   refused, do not release paid automation; restrict any public app to local
   organisation and deep links to the free official service.
