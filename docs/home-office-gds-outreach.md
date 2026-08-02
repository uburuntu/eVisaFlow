# Home Office/GDS Authorization Request

Status: draft only. Review with counsel before sending.

Do not attach real eVisa records, credentials, OTPs, or production diagnostics.

## Draft email

Subject: Request for written authorization or policy position - independent eVisaFlow mobile application

Dear Digital Status / View and Prove Product Team,

I am the creator of eVisaFlow, an independent and unofficial convenience
application designed to help people securely organise previously generated eVisa
proofs and share codes for offline access, sharing, and printing.

We are preparing private iOS and Android testing under these identifiers:

- Operating legal entity: `[LEGAL ENTITY]`
- iOS bundle ID: `com.evisaflow.mobile`
- Android package ID: `com.evisaflow.mobile`
- Repository/security information: `[URL]`
- Security and incident contact: `[EMAIL / PHONE]`

The mobile application does not contain a browser-automation engine. Where enabled,
a backend worker uses a temporary Playwright browser session to follow the public
View and Prove journey. The user supplies the relevant identity details and enters
the one-time code sent by UKVI. eVisaFlow does not bypass OTP, CAPTCHA, fraud
controls, rate limits, access restrictions, or session protections.

Applicant details and returned documents are encrypted. OTPs exist in memory only.
Server-side result artifacts have short retention and are removed after successful,
verified encrypted storage on the user's device. Saved copies remain device-local by
default.

eVisaFlow is not presented as an official government product. It links directly to
the free official GOV.UK service and states prominently that any future payment would
cover independent convenience features, not an eVisa, immigration status, share
code, or government service. No payment is enabled during private testing.

Please provide a written answer to each question below:

1. May a third-party application automate the View and Prove journey when the status
   holder supplies their identity details and one-time security code?
2. May an adult act for another adult who has expressly authorised them?
3. May a parent or legal guardian act for a child or dependant?
4. What evidence of authority, consent, or guardianship should be obtained or
   retained?
5. Is browser automation permitted, or must integrations use an approved API or
   partner route?
6. May the application generate and download the eVisa PDF and share-code result?
7. May it retain encrypted copies on the status holder's device for offline access?
8. May it retain or generate checker HTML/PDF representations, and are there
   restrictions on sanitising, standalone viewing, printing, or sharing them?
9. May the application be distributed through Apple's App Store and Google Play?
10. May the operator charge for independent convenience features while clearly
    stating that the official government service is free?
11. Are there request-rate, concurrency, scheduling, automated-refresh, or fair-use
    limits?
12. Is a specific User-Agent, integration identifier, or operator-contact header
    required?
13. Are any names, descriptions, screenshots, icons, colours, or references to
    GOV.UK, Home Office, or UKVI required or prohibited?
14. What disclaimer and official-source attribution should appear?
15. Are there required security controls, retention limits, audit records, or
    incident-notification timelines?
16. Which operational/security contact should receive reports of automation failure,
    abuse, or vulnerabilities?
17. How would breaking changes, suspension, or revocation of permission be
    communicated?
18. May the written response be supplied to Apple and Google as authorization
    evidence?
19. Can the response identify the legal entity and bundle/package IDs it covers?
20. Is there a supported partner or API programme that eVisaFlow should join?

If the described use is permitted, please identify any conditions and a named contact
whom Apple or Google may use to validate the position. If it is not permitted, please
identify the relevant terms or policy and any supported route eVisaFlow should use.

We can provide a data-flow diagram, threat model, DPIA draft, demonstration build,
security controls, and rate-limit proposal.

Kind regards,

`[NAME]`  
`[LEGAL ENTITY]`  
`[CONTACT DETAILS]`

## Evidence handling

- Store the sent message, complete headers, attachments, responses, and follow-ups in
  the private legal evidence repository.
- Record the government team, named responder, date, scope, conditions, expiry, and
  validation contact in `docs/public-launch-gates.md` without committing confidential
  correspondence.
- Do not close `AUTH-01` or `AUTH-02` from an oral conversation, generic helpdesk
  response, or lack of reply.
