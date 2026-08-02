# Mobile end-to-end tests

The mobile app uses Maestro for black-box Android and iOS journeys. Tests interact
through React Native accessibility identifiers and use only fictional identity data.
They do not call GOV.UK or require a production account.

## Test layers

- `profile-lifecycle.yaml` is the critical smoke journey: first-launch disclosure,
  encrypted profile creation, process restart, vault persistence, and deletion.
- `profile-validation.yaml` verifies that incomplete or malformed identity data never
  enters the vault.
- `free-profile-limit.yaml` protects the one-person free entitlement boundary.
- `delete-all-data.yaml` verifies account deletion, vault crypto-erasure, and a clean
  restart.
- `invalid-security-code.yaml` protects OTP feedback from being erased by background
  status polling.
- `offline-proof.yaml` runs the fixture-backed worker journey through OTP, encrypted
  artifact persistence, process restart, and reopening the proof offline.
- `review/` contains a paired fictional-data setup and proof journey used only for
  focused PR recording; the user-facing journey is recorded without the setup form.
- `accessibility/large-text.yaml` raises the device to its maximum text setting and
  verifies that the dashboard and primary navigation remain usable at the app's 200%
  accessibility scale ceiling.
- Reusable setup lives under `maestro/subflows/`; files there are not discovered as
  standalone tests.

Every independently executed suite flow launches with `clearState: true`, so tests can
run in any order. The visual-review pair deliberately shares its fixture state. Release
E2E builds compile with `EXPO_PUBLIC_EVISAFLOW_DEMO_MODE=true` and use fictional
artifacts; test YAML never intercepts or mocks production traffic.

## Running locally

For Android, boot an emulator in Android Studio and run the complete local pipeline:

```sh
make mobile-e2e-android
```

The target generates the native Android project, builds a Release APK for ARM64,
installs it, and runs every Maestro flow. Override `ANDROID_DEVICE` when more than
one device is connected, or `ANDROID_ARCH` for a non-ARM emulator. Android flows
run in isolated Maestro processes so a driver failure cannot contaminate the next
journey; each flow receives its own JUnit report and debug directory. The runner
restores the emulator's original font scale after the accessibility journey.

For iOS, boot Simulator and run the complete local pipeline:

```sh
make mobile-e2e-ios
```

Select a specific installed simulator when needed:

```sh
make mobile-e2e-ios IOS_DEVICE="iPhone 17 Pro"
```

The target prebuilds iOS, installs pods, creates a Release simulator app, installs
it, and runs all Maestro flows. It also embeds a test-only Keychain entitlement
for ad-hoc simulator builds; App Store entitlements continue to come from Expo
configuration and Apple's provisioning profile.
The runner also restores the simulator's original content-size category after the
large-text journey. For PR review it records the focused proof journey with the native
Simulator recorder, transcodes it to a metadata-filtered 720p MP4, and rejects empty or
single-frame-sized output.

For an already installed Android or iOS build, run `pnpm e2e:mobile` or
`pnpm e2e:mobile:smoke` directly.

Maestro captures JUnit, screenshots, recordings, command diagnostics, and native logs.
CI retains those artifacts and publishes deterministic iOS and Android screenshots and
focused journey videos in one bot-owned PR comment. It also retains a failing app binary
for reproduction. Run the critical suite for every mobile change on Android and iOS;
run the broader suite nightly and before a store submission.
