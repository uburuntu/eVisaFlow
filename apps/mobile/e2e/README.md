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

1. Install Maestro and boot an Android emulator or iOS simulator.
2. Install a native eVisaFlow build with application ID `com.evisaflow.mobile`.
3. From the repository root, run `pnpm e2e:mobile` or `pnpm e2e:mobile:smoke`.

Maestro captures diagnostic artifacts on failure. CI should retain those artifacts,
the JUnit report, the app binary, and native device logs. Run the critical suite for
every mobile change on Android and iOS; run the broader suite nightly and before a
store submission.
