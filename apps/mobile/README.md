# eVisaFlow mobile

Expo/React Native client for Android and iOS. Playwright remains in server workers;
the installed app manages encrypted local profiles and communicates with the mobile
API once that service is available.

## Current foundation

- first-run unofficial-service and authority disclosure;
- device-local offline document vault and people profiles;
- AES-256-GCM encrypted profile manifest;
- non-migrating key in iOS Keychain or Android Keystore through SecureStore;
- atomic vault writes, per-profile deletion, and recovery reset;
- Maestro Android/iOS lifecycle, validation, and free-limit journeys.

Live share-code generation, result history, subscriptions, reminders, and the review
fixture service are later milestones. The current UI does not expose inactive controls
for those features.

## Development

From the repository root:

```sh
pnpm install
pnpm dev:mobile
```

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
