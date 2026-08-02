# Mobile E2E agent notes

## Scope
- These are black-box Maestro journeys against native release builds, not component
  tests and not Expo Go tests.
- Tests use React Native accessibility identifiers and only deterministic fictional
  identities, share codes, and artifacts.
- E2E builds set `EXPO_PUBLIC_EVISAFLOW_DEMO_MODE=true`; they must never contact GOV.UK
  or a production Supabase project.

## Flow contract
- Standalone flows under `maestro/flows/` launch with `clearState: true` and must be
  order-independent.
- Reusable setup belongs under `maestro/subflows/` so Maestro does not discover it as
  an independent test.
- The paired `maestro/review/` setup and journey intentionally share state to record a
  concise user-facing proof flow without recording profile setup.
- Keep the following coverage:
  - encrypted profile lifecycle across process restart and deletion;
  - invalid profile input rejection;
  - one-profile free-plan boundary;
  - full local/service deletion and clean restart;
  - invalid OTP remains actionable while status refresh continues;
  - complete proof generation, OTP, artifact persistence, restart, and offline reopen;
  - opt-in reminder preference persists without exposing notification content;
  - one proof can be deleted without deleting its person;
  - a selected saved proof reaches the warned printable-summary screen;
  - dashboard navigation and scrolled controls at 200% text.
- When adding a high-risk workflow, add a black-box failure/recovery journey rather
  than relying only on a happy-path screenshot.

## Visual contract
- Required screenshot basenames are consumed by `scripts/collect-mobile-visuals.sh`:
  `dashboard-before-proof`, `choose-purpose`, `security-code`,
  `saved-offline-proof`, `dashboard-with-offline-proof`, `privacy-settings`,
  `offline-summary`, `large-text-dashboard`, and `large-text-dashboard-bottom`.
- Required recording basename: `offline-proof-journey.mp4`.
- Android records inside the shared proof subflow. iOS records only the focused review
  flow. The iOS runner then uses `avconvert` to publish a metadata-filtered H.264 720p
  copy at the stable collector path.
- Do not accept blank, one-frame, tiny, corrupt, clipped, or personal-data media.
  Inspect contact sheets and video frame counts before considering visual CI complete.

## Platform runners
- `make mobile-e2e-android` prebuilds Android, assembles an ARM64 Release APK, installs
  it on a booted emulator, runs each main flow in an isolated Maestro process, raises
  font scale to 2.0 for accessibility, restores it, and captures logcat.
- `make mobile-e2e-ios` prebuilds iOS, installs pods, builds a Release simulator app,
  validates the simulator-only Keychain entitlement, runs the suite and focused
  recording, raises the content-size category, restores it, and captures simulator
  logs.
- Override devices with `ANDROID_DEVICE`, `ANDROID_ARCH`, or `IOS_DEVICE` as documented
  in `README.md` and the root Makefile.
- The runners may only recursively clean paths below `apps/mobile/e2e/results/`.

## Diagnostics and CI
- Preserve JUnit, Maestro command artifacts, native logs, screenshots, recordings,
  and a failing binary for reproduction.
- Every mobile PR must update the single bot-owned visual-review comment for both
  platforms. Do not replace it with transient Actions artifacts alone.
- Run both local release suites before pushing workflow changes. Also run `actionlint`
  for workflow edits and `shellcheck` for runner edits.
- Stable accessibility IDs are a public test interface. Rename them only with the app
  and every affected flow in the same change.
