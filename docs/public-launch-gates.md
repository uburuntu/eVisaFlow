# eVisaFlow Public Launch Gates

Last reviewed: 2026-08-02

## Current decision

| Release stage | Status | Allowed now |
| --- | --- | --- |
| Creator/internal live automation | Conditional go | Small, authorised, unpaid testing with monitoring, caps, kill switch, and official-service fallback |
| TestFlight / closed Play beta | Conditional go | Fictional review mode and device-local features; external live automation remains gated |
| Free public local-only release | No-go | Reconsider only after the legal, privacy, store, and physical-quality gates below |
| Public live automation | No-go | Requires written service authorization or a counsel-approved equivalent position |
| Paid release | No-go | Requires every public-automation gate plus native billing and durable execution |

This file is the canonical release register. `docs/mobile-app-plan.md` contains the
remaining implementation roadmap, but a public release decision must be made from
this register.

## Immediate accountable actions

1. Founder: send the request in `docs/home-office-gds-outreach.md` and retain the
   complete response as authorization evidence; do not enable external live automation
   while `AUTH-01` is open.
2. Founder: establish the operating legal entity and begin matching Apple and Google
   organisation enrolment.
3. Privacy counsel/DPO: decide the proxy, guardian, Article 6/9/14, controller,
   retention, transfer, deletion, and ICO positions; own the DPIA.
4. Release owner: seek early Apple/Google review of the fictional demo and government-
   service authorization package before promising a store launch.
5. Operator/mobile QA: deploy the capped internal beta behind TLS, exercise its kill
   switch, and record the physical-device matrix in
   `docs/mobile-physical-beta-runbook.md`.

## Status rules

- Valid statuses are `not_started`, `in_progress`, `blocked`, and `complete`.
- A gate may be marked `complete` only when its Evidence cell links to durable proof.
- Product or implementation pull requests must update every gate they materially
  affect.
- Legal and store-policy interpretations are not complete until reviewed by the named
  accountable owner. Repository implementation alone cannot close those gates.
- Until every gate required for a release stage is complete, that stage remains
  no-go even if the application binary is technically ready.

## Authorization and store policy

| ID | Required before | Status | Owner | Completion criteria | Evidence |
| --- | --- | --- | --- | --- | --- |
| AUTH-01 | Public automation | not_started | Founder | Written Home Office/GDS authorization, non-objection, or clear policy position covers user-authorised browser automation, adult proxy use, guardian use, downloads, retention, distribution, rates, and revocation | [Outreach draft](home-office-gds-outreach.md) is ready but has not been sent |
| AUTH-02 | Paid release | not_started | Founder | AUTH-01 explicitly covers charging for independent convenience and automation features while the official service remains free | Pending |
| STORE-01 | External Apple beta | not_started | Release owner | Apple accepts the fictional review approach and the authorization package addresses Guidelines 2.1, 5.1.1, and 5.2.2 | Pending |
| STORE-02 | External Play beta | not_started | Release owner | Google government-services declaration, official-source attribution, and government authorization evidence are prepared and validated | Pending |
| STORE-03 | Any store release | in_progress | Brand owner | Name, icon, screenshots, colours, metadata, and in-app wording cannot imply government affiliation | Neutral in-app identity and fictional visual evidence exist in PR #4; store metadata review remains |

## Legal entity and data protection

| ID | Required before | Status | Owner | Completion criteria | Evidence |
| --- | --- | --- | --- | --- | --- |
| LEGAL-01 | Public release | not_started | Founder | Operating legal entity exists and Apple/Google organisation enrolment uses matching details | Pending |
| PRIV-01 | External beta | not_started | Privacy counsel | Controller/processor roles and Article 6 basis are documented for self and adult-proxy use | Pending |
| PRIV-02 | External beta | not_started | Privacy counsel | Children, guardians, adults lacking capacity, Article 9, and Article 14 duties have an approved product model | Pending |
| PRIV-03 | Public release | not_started | Privacy owner | DPIA, records of processing, legitimate-interests assessment where needed, residual-risk acceptance, and ICO fee assessment are complete | Pending |
| PRIV-04 | Public release | not_started | Privacy owner | Vendor/subprocessor map, UK/EEA regions, international-transfer mechanisms, and retention schedule match production | Pending |
| PRIV-05 | External beta | in_progress | Product owner | Privacy notice, terms, support page, in-app deletion, and public web deletion path are live and match actual behavior | In-app disclosure and deletion are tested; public privacy, terms, support, and deletion pages remain |
| PRIV-06 | Public release | not_started | Privacy owner | Backup expiry, incident response, subject-rights handling, breach response, and support-access procedures are documented and exercised | Pending |

## Architecture and security

| ID | Required before | Status | Owner | Completion criteria | Evidence |
| --- | --- | --- | --- | --- | --- |
| ARCH-01 | Internal live beta | in_progress | Backend owner | TLS deployment, migration 004+, anonymous Auth, private bucket, body limits, secrets, monitoring, daily cap, and maintenance kill switch are configured | Migrations 004/005, the default 25-run UTC cap, maintenance flag, and safe API responses exist; deployed TLS/monitoring evidence remains |
| ARCH-02 | Quota or paid beta | in_progress | Mobile/backend owners | Result transfer uses two-phase claim; no allowance is consumed before verified local persistence; interruption and disk-full recovery are tested | [Migration 005](../service/migrations/005_two_phase_mobile_claim.sql), API/migration tests, encrypted pending acknowledgements, and Release E2E cover the normal/restart path; disk-full and transfer-interruption evidence remains |
| ARCH-03 | Paid or scaled automation | blocked | Backend owner | Durable queue, leases/fencing, pre/post-navigation crash rules, drain/shutdown, backpressure, and chaos tests support multiple replicas | Blocked on topology decision |
| SEC-01 | Public release | not_started | Security owner | Service-role and encryption secrets use managed storage, separated/versioned data keys, rotation, least privilege, and environment isolation | Pending |
| SEC-02 | External beta | in_progress | Security owner | Logs and diagnostics are allowlisted, sensitive canaries are rejected in CI, artifacts never enter telemetry, and support bundles are safe | `service/tests/logger.test.js` exercises passport, DOB, share-code, bearer-token, and email canaries; production log scanning/support procedure remains |
| SEC-03 | Public release | not_started | Security owner | External threat model covers token theft, replay, abuse, storage, queue denial, logs, backups, screenshots, clipboard, and temporary files | Pending |
| SEC-04 | Public release | not_started | Security owner | No Critical or High security/privacy finding remains unmitigated; incident, kill-switch, and key-rotation exercises pass | Pending |
| SEC-05 | Later risk rollout | not_started | Mobile/security owners | App Attest/Play Integrity abstraction and risk-tier behavior never block saved offline proofs or deletion | Deferred; not a beta blocker |
| EXPORT-01 | Apple distribution | not_started | Release/legal owners | App Store encryption questionnaire and written AES-GCM/TLS export analysis support the selected declaration and storefronts | Pending |

## Product integrity and commercial model

| ID | Required before | Status | Owner | Completion criteria | Evidence |
| --- | --- | --- | --- | --- | --- |
| PROD-01 | Internal beta | complete | Product owner | UI separates saved time, last online check, and share-code expiry; it never promises current status, border acceptance, or official status | `app/documents/[id].tsx`, the fictional Release journey, and PR #4 screenshots show all three timestamps plus saved-copy/travel warnings |
| PROD-02 | External beta | complete | Mobile owner | Offline-ready means downloaded, hash-verified, encrypted, atomically committed, and decrypt/read-back verified | `src/vault/vault.ts`, two-phase API tests, and the process-restart offline-proof Release journey enforce the invariant; physical adverse-condition evidence is separately gated by QA-01/03 |
| PROD-03 | Public release | in_progress | Product/legal owners | Unofficial disclosure, free official-service link, authority declaration, travel warning, and store wording receive policy/legal review | Required in-app wording is implemented and [store/paywall copy is drafted](store-and-paywall-copy-draft.md); policy/legal approval remains |
| PROD-04 | Public release | not_started | Product owner | Local-only/manual-import fallback can be enabled without shipping automation or misleading users | Pending product decision |
| BILL-01 | Paid release | blocked | Product owner | Free/paid boundary and reasonable-use policy are approved; no per-result or government-output framing is used | Blocked on authorization and research |
| BILL-02 | Paid release | blocked | Mobile/backend owners | StoreKit/Play Billing through RevenueCat covers purchase, restore, optional account linking, refunds, grace, retry, transfer, and reconciliation | Blocked on BILL-01 |
| BILL-03 | Paid release | blocked | Finance/product owners | Store fees, worker cost, support, VAT, refunds, usage, retention, and price experiment support viable unit economics | Blocked on live beta data |

## Physical quality and operations

| ID | Required before | Status | Owner | Completion criteria | Evidence |
| --- | --- | --- | --- | --- | --- |
| QA-01 | External beta | in_progress | Mobile QA | Physical iOS/Android matrix passes encryption, reboot, airplane mode, low storage, uninstall, backup/restore, OS upgrade, sharing, printing, and deletion | [Physical beta runbook](mobile-physical-beta-runbook.md) and native simulator suites exist; physical results remain mandatory |
| QA-02 | External beta | in_progress | Accessibility owner | VoiceOver and TalkBack critical tasks pass on physical devices; maximum text, contrast, reduced motion, keyboard, switch control, and tablets are checked | Automated 200% text screenshots exist on both platforms; physical assistive-technology evidence remains |
| QA-03 | External live beta | in_progress | Mobile/backend QA | Captive portal, TLS failure, latency, packet loss, handover, backgrounding, process death, OTP expiry, duplicate taps, server restart, and overload follow documented recovery semantics | Process restart, invalid OTP, SSE recovery, idempotency, and overload responses are automated; hostile-network and live restart evidence remains |
| OPS-01 | Internal live beta | in_progress | Operator | Named operator, status message, official fallback, deployment drain, daily review, support path, incident contact, and kill-switch runbook are exercised | Maintenance flag, daily cap, and official fallback exist; named operator and production-like exercise remain |
| OPS-02 | Public release | not_started | Operations owner | Backups, deletion verification, alerts, dashboards, escalation, rollback, and support staffing meet the published SLA | Pending |
| METRIC-01 | Public automation | not_started | Product/QA owners | At least 100 private-beta eligible runs achieve 95% app-controlled success; public evidence later reaches 250 runs and the defined confidence target | Pending |
| METRIC-02 | Public release | in_progress | Mobile QA | At least 500 meaningful beta sessions reach 99.5% crash-free; zero verified offline proofs are lost across 200 persistence cycles | Deterministic process-restart E2E exists; required beta volume and physical persistence cycles remain |
| METRIC-03 | Public release | in_progress | Security/QA owners | Production-like scanning finds zero personal data in telemetry, logs, CI media, and support bundles | Synthetic logger canaries and fictional-only CI media exist; production-like log/support scanning remains |

## Evidence package required for a go decision

A release decision record must link to:

1. the exact application commit and native build identifiers;
2. authorization and counsel documents;
3. approved DPIA, privacy, terms, deletion, and transfer records;
4. store declarations, review instructions, fictional screenshots, and export analysis;
5. security review, key-rotation, incident, kill-switch, and rollback evidence;
6. physical accessibility, backup, hostile-network, printing, sharing, and deletion results;
7. measured crash, success, persistence, queue, privacy, and support metrics; and
8. an explicit signed go/no-go decision naming the release stage.
