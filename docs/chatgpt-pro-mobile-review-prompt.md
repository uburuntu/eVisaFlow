# Copy-ready ChatGPT Pro prompt

You are reviewing eVisaFlow before its first private mobile beta. Act as a combined
senior mobile product lead, Apple/Google store-policy reviewer, UK privacy/security
architect, and distributed-systems engineer. The current date is August 2026.

Use current primary sources and cite them with direct links and access dates. Prefer
official Apple, Google, GOV.UK/Home Office/GDS, ICO, Supabase, Expo, and RevenueCat
documentation. Clearly distinguish a documented rule from your interpretation. Do not
assume that an unofficial disclaimer, user consent, or technical feasibility creates
permission to automate a government service. Challenge weak assumptions.

Public implementation evidence:

- Repository: https://github.com/uburuntu/eVisaFlow
- Draft mobile PR: https://github.com/uburuntu/eVisaFlow/pull/4
- Automated iOS/Android screenshots and videos:
  https://github.com/uburuntu/eVisaFlow/pull/4#issuecomment-5155090230

Inspect those links when your browsing environment permits it. If the code or media is
unavailable, use the implementation summary below and state that limitation.

## Product context

eVisaFlow is an independent, unofficial convenience tool. Its primary mobile value is
reliable offline access to a previously generated UK eVisa proof, share code, and
printable files. A user may manage themselves or several other people when they are a
parent/guardian or authorised proxy. Multiple people are an extension of the offline
vault, not "family" branding.

The critical scenario is an older or non-technical person at a border with poor or no
connectivity after a trusted relative completed initial setup. They must be able to
open the correct saved proof, understand whether it is current, and share or print it
without assistance.

The app must remain clearly unofficial, avoid government branding, and link directly
to the free official GOV.UK service. Paid wording must say that payment covers
convenience, automation, encrypted organisation, and related app features, not the
government service itself.

## Implemented foundation

- One Expo SDK 56 / React Native 0.85 codebase for iOS 16.4+ and Android 9+.
- Playwright Chromium runs only on the Node.js backend; it is not embedded in the app.
- The app opens on an offline document vault, with profiles as a supporting layer.
- First-run unofficial-status and authority disclosure.
- Manual profile entry for document type/number, date of birth, SMS/email OTP method,
  and authority basis.
- Purpose confirmation for right to work, right to rent, or another immigration-status
  check.
- Silent Supabase anonymous Auth and an authenticated Fastify API.
- AES-256-GCM encrypted local vault, artifacts, and auth-session file; keys are held in
  Keychain/Keystore via SecureStore and are device-only.
- Server-side encrypted applicant/result payloads, memory-only OTPs, private encrypted
  Supabase Storage artifacts, short retention, account deletion, ownership checks,
  rate limits, and no-store authenticated responses.
- Client-generated idempotent run IDs, progress/status recovery, OTP entry,
  cancellation, one-time result claim, byte-length/SHA-256 verification, encrypted
  offline persistence, copy/share/print, expiry display, and app-switcher privacy.
- Free/backend baseline: one profile and three complete claimed results. A database
  `evisaflow_pro` entitlement supports six profiles and unlimited results, but no store
  purchase/restore flow exists yet.
- Deterministic fictional App Review mode.
- Release-build Maestro E2E on hosted iOS and Android, including deletion, validation,
  profile lifecycle, free limit, invalid OTP, offline persistence across restart, and
  top-to-bottom 200% text checks. Every mobile PR publishes screenshots and videos for
  both platforms.

## Known uncertainties and incomplete work

1. We do not yet have written Home Office/GDS permission for user-authorised
   automation, proxy use, downloads, monetization, branding, or app-store distribution.
2. We need a current, defensible Apple and Google policy assessment for an unofficial
   app facilitating access to a government immigration service.
3. Legal-entity accounts, DPIA, privacy/terms/deletion pages, ICO assessment, and Apple
   encryption export compliance are incomplete.
4. RevenueCat/StoreKit/Play Billing, webhook reconciliation, restore behavior, refunds,
   grace periods, and paywall/store wording are not implemented.
5. Anonymous identity makes lifetime free limits and reinstall/cross-device purchase
   restoration weak. We do not want invasive device fingerprinting.
6. The current browser queue and OTP broker are in-process. A service restart marks
   active runs interrupted instead of replaying a possibly-started GOV.UK session.
   This is suitable only for a single-replica beta unless reviewed otherwise.
7. The API has SSE events, but the app currently polls the authoritative run snapshot
   every 1.2 seconds.
8. App Attest/DeviceCheck/Play Integrity, optional biometric lock, local reminders,
   and sequential multi-person generation are not implemented.
9. Physical VoiceOver/TalkBack, hostile network, backup/restore, real print/share, and
   TestFlight/Play closed-beta verification remain outstanding.
10. We have not decided whether checker HTML needs a hardened in-app viewer or should
    remain an encrypted file shared to the operating system.

## Questions to answer

### Permission, store policy, and legal

1. What are the plausible hard blockers to distributing and monetizing this app now?
   Map each conclusion to the exact current Apple App Review and Google Play policy
   sections and explain where written third-party authorization is likely required.
2. What exact written questions should we send to Home Office/GDS? Draft a concise
   authorization request that covers account-holder consent, authorised adults,
   parents/guardians, document generation/download, app distribution, monetization,
   rate limits, branding, security, and incident contact.
3. What disclaimer and official-source attribution should appear in onboarding, the
   app, and both store listings? Explain what the disclaimer cannot solve.
4. For UK GDPR, identify likely controller/processor roles, lawful-basis questions,
   consent/authority evidence, child/guardian issues, DPIA scope, retention and deletion
   obligations, international-transfer concerns, and ICO registration questions. Mark
   anything that requires UK counsel rather than product judgment.
5. What Apple encryption export-compliance analysis/declarations are likely for an app
   using standard AES-GCM through Expo/native platform crypto?

### Commercial model

6. Critique one free profile plus three lifetime complete results and Pro at six
   profiles/unlimited results. Is the trigger understandable, defensible, and aligned
   with the value? Compare subscription, annual-only, one-time purchase, per-result,
   and freemium alternatives, including likely store-policy perception and backend
   cost/risk.
7. Recommend a concrete RevenueCat identity and restoration model given anonymous
   Supabase Auth. Address reinstall, same-platform restore, cross-platform restore,
   family sharing, refunds, billing retry, offline grace, webhook replay/idempotency,
   and entitlement reconciliation. State whether optional account linking is worth the
   privacy and UX cost.
8. Review GBP 3.99 monthly / GBP 24.99 yearly as a starting hypothesis. Specify what
   cost and conversion data we need before fixing prices.
9. Draft precise paywall and store wording that sells convenience without implying a
   fee for the government service or official affiliation.

### Production architecture and security

10. Is a single-replica in-process queue acceptable for a private beta? Give explicit
    traffic, reliability, and operational thresholds that should force a move to a
    durable queue/separate worker topology.
11. Recommend the production topology. Compare Supabase PGMQ, another managed queue,
    and the current process. Define leases, per-user serialization, global concurrency,
    backpressure, crash-before-navigation replay, crash-after-navigation interruption,
    OTP routing without persistence, cancellation, duplicate prevention, artifact
    packaging idempotency, and graceful shutdown.
12. Should the app adopt SSE or keep 1.2-second polling? Evaluate battery, unreliable
    mobile networks, reverse proxies, background/resume, reconnection, server cost, and
    complexity. Give a clear recommendation and fallback behavior.
13. Produce a threat model for anonymous token theft, API replay/abuse, service-role or
    encryption-key exposure, artifact enumeration, queue denial of service, rooted or
    jailbroken devices, local backup/restore, screenshots/clipboard, temporary files,
    logs, and support diagnostics. Prioritize mitigations.
14. Recommend current supported App Attest/DeviceCheck and Play Integrity integration
    options for Expo SDK 56/native builds. Explain how to avoid locking a legitimate
    user out of already saved offline documents when attestation is unavailable or
    wrong.
15. Review the local encryption/crypto-erasure model and say what must be verified on
    physical iOS and Android devices, especially backup, Keychain accessibility,
    uninstall/reinstall, biometric-set changes, and OS upgrades.

### User value, accessibility, and beta

16. Design the simplest trusted-helper handoff and offline-border workflow for an older
    user. Identify the minimum screens/actions, readiness indicators, expiry language,
    and failure recovery. Avoid cloud profile sync unless you can justify it.
17. Prioritize local reminders, optional biometric locking, sequential multi-person
    generation, per-proof deletion/storage management, emergency printable bundle, and
    hardened HTML viewing. Explain user value, risk, and dependency order.
18. Define a physical-device beta matrix covering VoiceOver/TalkBack, 200% text, small
    phones/tablets, poor network, airplane mode, app/process death, OTP expiry, server
    restart, low storage, PDF print/share, clipboard, backup/restore, and deletion
    failure.
19. Are these beta exit targets reasonable: 99.5% crash-free sessions, 95% app-
    controlled run success excluding GOV.UK/user errors, zero personal data in
    telemetry, no lost verified offline proof, and a repeat path of at most two taps
    before OTP? Propose better measurable definitions where needed.
20. Give a stop/go recommendation for: internal live testing, TestFlight/closed Play
    beta, free public release, and paid public release.

## Required output

Return:

1. an executive stop/go decision for each release stage;
2. a risk register with severity, likelihood, evidence, owner, mitigation, and release
   gate;
3. explicit recommendations for every unresolved decision above, including tradeoffs;
4. a prioritized two-week, six-week, and pre-launch backlog with acceptance criteria;
5. the Home Office/GDS outreach draft;
6. Apple and Google submission checklists, including fictional review-mode notes;
7. a UK legal/privacy question list for counsel/DPO;
8. a production architecture recommendation with a textual sequence diagram for run,
   OTP, claim, failure, and restart paths;
9. a physical-device and adverse-network test matrix;
10. citations to current primary sources.

Do not answer with generic startup advice. Flag any claim you cannot verify, state what
evidence would resolve it, and separate mandatory launch blockers from sensible later
improvements.
