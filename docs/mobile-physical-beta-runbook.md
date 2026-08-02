# Mobile Physical Beta Runbook

Use fictional data unless a specifically authorised internal live run is required.
Never commit device logs, screenshots, videos, or support bundles containing personal
data. Store evidence privately and link only a sanitized summary from
`docs/public-launch-gates.md`.

## Required devices

- Smallest supported iPhone on iOS 16.4 or later, one current iPhone, and one iPad.
- Android 9 low-end phone, one current Pixel, one current Samsung, and one tablet.
- At least one device with limited free storage and one device eligible for an OS
  upgrade test.

Record model, OS/build, app commit, native build ID, locale, text size, accessibility
configuration, result, evidence location, tester, and date for every scenario.

## Offline-ready acceptance

For each platform:

1. Generate a fictional proof and wait for `Available offline`.
2. Force-quit the app, enable airplane mode, relaunch, and open the same proof.
3. Open each saved PDF and confirm the expected fictional content.
4. Reboot in airplane mode and repeat.
5. Start Share and Print, cancel each, then confirm no plaintext remains in the app's
   temporary directories after relaunch.
6. Confirm the generated time, saved time, and share-code expiry are distinct and
   correct.
7. Delete one proof and verify its person/profile remains.
8. Delete all data and verify the vault cannot be recovered.

`PROD-02` and the offline persistence portion of `QA-01` require zero failures.

## Storage, key, and lifecycle matrix

- Fill storage below the package size during download and atomic commit. The app must
  not show `Available offline`, consume allowance, or retain staging files.
- Kill the process while queued, awaiting OTP, downloading, encrypting, committing,
  and acknowledging. Recovery must match the documented phase semantics.
- Test app offload and full uninstall on iOS; app-data clear and uninstall on Android.
- Test same-device restore and different-device migration. The beta expectation is
  device-local/no-backup behavior, never silent recovery.
- Add/remove biometrics and change the device passcode. The current non-biometric
  device-only key must remain usable where the OS permits.
- Upgrade each platform by one supported major OS version and reopen every saved
  proof.
- Verify Android backup rules on Google restore and one major OEM restore path.

## Network and server recovery

- Exercise 400-1500 ms latency, 5-20% packet loss, Wi-Fi/cellular handover, captive
  portal, DNS failure, and invalid TLS.
- Background and resume during every run phase; SSE must reconnect through an
  authoritative snapshot without creating another run.
- Submit wrong and expired OTPs, duplicate taps, and cancellation at the deadline.
- Restart the single beta service before and after GOV.UK navigation. Pre-navigation
  behavior may be retried only where documented; post-navigation work must become
  interrupted without automatic replay.
- Fill the queue past its cap, exercise the daily limit, and turn maintenance mode on
  while existing saved proofs remain available.

## Accessibility

- Complete onboarding, profile setup, saved-proof opening, copying, sharing,
  printing, deletion, reminders, and account deletion with VoiceOver and TalkBack.
- Verify logical focus, named controls, announcements, and a readable share code.
- Repeat at 200% and maximum accessibility text, increased contrast, reduced motion,
  landscape where permitted, external keyboard, Switch Control, and Android switch
  access.
- No critical action may depend only on colour, a gesture, or an unlabeled icon.

## Reminders, export, and privacy

- Deny notification permission, enable it later in system settings, reboot, and verify
  reconciliation.
- Verify only the newest proof per person and purpose schedules reminders at 30, 14,
  7, and 1 days; notification text must contain no name, status, code, or expiry.
- Verify the offline summary contains no DOB or identity-document number and clearly
  states that it is unofficial, may be stale, and does not replace a linked travel
  document.
- Test Files, Mail, Messages, AirPrint, Android Files, Gmail, Messages, and one Android
  print service. Document recipient-app retention as outside eVisaFlow's control.
- Inspect app switcher, screenshots, clipboard, logs, crash reports, and support
  diagnostics for sensitive values.

## Exit record

The test owner produces a signed sanitized summary covering failures, fixes, retests,
residual risks, and evidence links. Update `QA-01`, `QA-02`, `QA-03`, `PROD-02`, and
the relevant metrics in `docs/public-launch-gates.md`; never mark them complete from
simulator automation alone.
