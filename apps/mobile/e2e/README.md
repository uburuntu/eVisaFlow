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
- Reusable setup lives under `maestro/subflows/`; files there are not discovered as
  standalone tests.

Every flow launches with `clearState: true`, so tests are independent and can run in
any order. A future fixture-backed run service will use a compile-time E2E mode and
fictional artifacts rather than mocking network calls inside test YAML.

## Running locally

For Android, boot an emulator in Android Studio and run the complete local pipeline:

```sh
make mobile-e2e-android
```

The target generates the native Android project, builds a Release APK for ARM64,
installs it, and runs every Maestro flow. Override `ANDROID_DEVICE` when more than
one device is connected, or `ANDROID_ARCH` for a non-ARM emulator. Android flows
run in isolated Maestro processes so a driver failure cannot contaminate the next
journey; each flow receives its own JUnit report and debug directory.

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

For an already installed Android or iOS build, run `pnpm e2e:mobile` or
`pnpm e2e:mobile:smoke` directly.

Maestro captures diagnostic artifacts on failure. CI should retain those artifacts,
the JUnit report, the app binary, and native device logs. Run the critical suite for
every mobile change on Android and iOS; run the broader suite nightly and before a
store submission.
