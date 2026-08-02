# eVisaFlow mobile

Expo/React Native client for Android and iOS. Playwright remains in server workers;
the installed app manages encrypted local profiles and communicates with the mobile
API once that service is available.

## Current capabilities

- first-run unofficial-service and authority disclosure;
- device-local offline document vault and people profiles;
- AES-256-GCM encrypted profile manifest;
- non-migrating key in iOS Keychain or Android Keystore through SecureStore;
- authenticated live runs with progress, resumable OTP challenges, and cancellation;
- hash-verified eVisa PDF, checker HTML/PDF, share, print, and copy actions;
- fixture-backed App Review mode using fictional data and artifacts;
- app-switcher privacy cover, expiry warnings, and full local/service deletion;
- 200% accessible text scaling with a dedicated maximum-system-size smoke journey;
- Maestro Android/iOS lifecycle, validation, entitlement, privacy, offline-proof, and
  large-text journeys.

Subscriptions, reminders, biometric locking, integrity attestation, and multi-person
batch runs remain later milestones. Store release remains gated by the authorization
and legal checks in [`docs/mobile-app-plan.md`](../../docs/mobile-app-plan.md).

## Development

From the repository root:

```sh
pnpm install
pnpm dev:mobile
```

Create `apps/mobile/.env.local` for a live development build:

```dotenv
EXPO_PUBLIC_EVISAFLOW_API_URL=https://api.example.com
EXPO_PUBLIC_SUPABASE_URL=https://project.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_example
```

These values are compiled into the app and must be public-client values. Never put the
Supabase service-role key or the server encryption key in an `EXPO_PUBLIC_*` variable.
CI and App Review builds set `EXPO_PUBLIC_EVISAFLOW_DEMO_MODE=true` and make no GOV.UK
requests.

The root command builds `@evisa-flow/protocol` before starting Expo. A native local
build needs JDK 17 and Android Studio for Android, or the Xcode version supported by
Expo SDK 56 and CocoaPods for iOS. Production testing must use a native development
or release build; Expo Go is useful for iteration but is not the production runtime.

Run static checks with:

```sh
pnpm run typecheck:mobile
pnpm run lint
```

`pnpm run check:mobile` compares direct native modules with the manifest bundled in the
installed Expo SDK. This deliberately validates against the quarantined SDK 56 patch in
the lockfile rather than bypassing the workspace's 72-hour minimum package age for a
newer patch.

See [e2e/README.md](e2e/README.md) for device journeys. Never enter real identity
details in fixtures, screenshots, recordings, CI, or review builds.
