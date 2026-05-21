import type { EVisaPhase } from "../types.js";
import type { PageSnapshot } from "./page-snapshot.js";

export type PageKind =
  | "entry_page"
  | "document_type"
  | "document_number"
  | "date_of_birth"
  | "two_factor_method"
  | "two_factor_code"
  | "prove_status"
  | "confirmation"
  | "purpose_selection"
  | "summary"
  | "download_pdf"
  | "auth_error"
  | "session_expired"
  | "service_unavailable"
  | "unknown";

export interface PageClassification {
  kind: PageKind;
  confidence: number;
  evidence: string[];
  alternatives: Array<{ kind: PageKind; confidence: number; evidence: string[] }>;
  phase: EVisaPhase;
}

const phaseByKind: Record<PageKind, EVisaPhase> = {
  entry_page: "launching",
  document_type: "verifying_identity",
  document_number: "verifying_identity",
  date_of_birth: "verifying_identity",
  two_factor_method: "choosing_2fa",
  two_factor_code: "waiting_for_2fa",
  prove_status: "viewing_status",
  confirmation: "viewing_status",
  purpose_selection: "creating_share_code",
  summary: "creating_share_code",
  download_pdf: "downloading_pdf",
  auth_error: "failed",
  session_expired: "failed",
  service_unavailable: "failed",
  unknown: "failed",
};

type Score = { kind: PageKind; confidence: number; evidence: string[] };

const hasControl = (
  snapshot: PageSnapshot,
  predicate: (control: PageSnapshot["controls"][number]) => boolean
): boolean => snapshot.controls.some(predicate);

const hasLink = (
  snapshot: PageSnapshot,
  predicate: (link: PageSnapshot["links"][number]) => boolean
): boolean => snapshot.links.some(predicate);

const hasHeading = (snapshot: PageSnapshot, pattern: RegExp): boolean =>
  snapshot.headings.some((heading) => pattern.test(heading));

const hasTitle = (snapshot: PageSnapshot, pattern: RegExp): boolean =>
  pattern.test(snapshot.title);

const hasPageText = (snapshot: PageSnapshot, pattern: RegExp): boolean =>
  pattern.test(snapshot.text) || pattern.test(snapshot.title);

const push = (
  scores: Score[],
  kind: PageKind,
  confidence: number,
  ...evidence: Array<string | false>
) => {
  scores.push({
    kind,
    confidence,
    evidence: evidence.filter((item): item is string => Boolean(item)),
  });
};

export const classifyPage = (snapshot: PageSnapshot): PageClassification => {
  const scores: Score[] = [];
  const text = snapshot.text;
  const errorText = snapshot.errors.join(" ");

  if (
    /signed out|session (has )?(expired|ended)|start again|timed out/i.test(errorText)
  ) {
    push(scores, "session_expired", 100, "govuk-error-summary:session-expired");
  }
  if (
    /incorrect|invalid|not match|could not find|security code|date of birth|document number|too many attempts/i.test(
      errorText
    )
  ) {
    push(scores, "auth_error", 95, "govuk-error-summary:auth-error");
  }
  if (/service unavailable|sorry, there is a problem/i.test(text)) {
    push(scores, "service_unavailable", 90, "body:service-unavailable");
  }

  if (
    hasLink(snapshot, (link) =>
      /view-immigration-status\.service\.gov\.uk\/status/.test(link.href ?? "")
    )
  ) {
    push(scores, "entry_page", 90, "link:view-immigration-status");
  } else if (
    (hasHeading(snapshot, /View your eVisa.*share code/i) ||
      hasTitle(snapshot, /View your eVisa.*share code/i)) &&
    hasPageText(snapshot, /UKVI account/i)
  ) {
    push(scores, "entry_page", 75, "heading:view-evisa", "body:ukvi-account");
  }

  if (hasControl(snapshot, (control) => control.name === "documentType")) {
    push(scores, "document_type", 100, "input[name=documentType]");
  } else if (
    hasHeading(snapshot, /identity document/i) &&
    hasPageText(snapshot, /UKVI account/i)
  ) {
    push(scores, "document_type", 75, "heading:identity-document", "body:ukvi-account");
  } else if (
    hasTitle(snapshot, /Which identity document do you use to sign in/i) &&
    hasPageText(snapshot, /UKVI account/i)
  ) {
    push(scores, "document_type", 70, "title:identity-document", "title:ukvi-account");
  }

  if (hasControl(snapshot, (control) => control.name === "documentNumber")) {
    push(scores, "document_number", 100, "input[name=documentNumber]");
  } else if (
    hasHeading(
      snapshot,
      /What is your (passport|national identity card|biometric residence card or permit|UKVI customer) number\?/i
    )
  ) {
    push(scores, "document_number", 80, "heading:document-number");
  }

  const hasDob =
    hasControl(snapshot, (control) => control.name === "dob-day") &&
    hasControl(snapshot, (control) => control.name === "dob-month") &&
    hasControl(snapshot, (control) => control.name === "dob-year");
  if (hasDob) {
    push(scores, "date_of_birth", 100, "input[name=dob-day/month/year]");
  } else if (hasHeading(snapshot, /What is your date of birth\?/i)) {
    push(scores, "date_of_birth", 80, "heading:date-of-birth");
  }

  if (hasControl(snapshot, (control) => control.name === "deliveryMethod")) {
    push(scores, "two_factor_method", 100, "input[name=deliveryMethod]");
  } else if (hasHeading(snapshot, /receive a security code/i)) {
    push(scores, "two_factor_method", 80, "heading:receive-security-code");
  }

  if (
    hasControl(
      snapshot,
      (control) => control.name === "verificationCode" || control.name === "code"
    ) &&
    /Security code/i.test(text)
  ) {
    push(scores, "two_factor_code", 100, "input[name=verificationCode|code]");
  }

  if (
    hasLink(snapshot, (link) => /(^|\/)get-share-code$/.test(link.href ?? "")) &&
    (hasHeading(snapshot, /Your immigration status|Prove your status/i) ||
      snapshot.controls.length > 0 ||
      /\.govuk-summary-list__row/.test(text))
  ) {
    push(scores, "prove_status", 85, "link:get-share-code");
  }

  if (
    hasLink(
      snapshot,
      (link) => /^Get share code$/i.test(link.text) || link.href === "/share"
    ) &&
    hasHeading(snapshot, /Get a share code to prove your status/i)
  ) {
    push(scores, "confirmation", 95, "link:get-share-code", "heading:prove-status");
  }

  if (hasControl(snapshot, (control) => control.name === "listedPurpose")) {
    push(scores, "purpose_selection", 100, "input[name=listedPurpose]");
  } else if (hasHeading(snapshot, /Why do you need a share code\?/i)) {
    push(scores, "purpose_selection", 80, "heading:share-code-purpose");
  }

  const isSummaryPreview =
    hasHeading(snapshot, /This is what the checker will see/i) ||
    hasHeading(snapshot, /Summary of what they can do in the UK/i) ||
    hasTitle(snapshot, /Preview your information/i) ||
    /Name\s+Date of birth|Valid from|Valid until/i.test(text);
  const hasCreateShareCodeAction =
    hasLink(
      snapshot,
      (link) =>
        /Create (a )?share code/i.test(link.text) ||
        /^\/share\/.*\/code$/.test(link.href ?? "")
    ) || snapshot.buttons.some((button) => /Create (a )?share code/i.test(button));

  if (hasCreateShareCodeAction && isSummaryPreview) {
    push(scores, "summary", 95, "link:create-share-code", "summary:checker-view");
  } else if (isSummaryPreview && /\/share\/[^/?#]+(?:$|[?#])/.test(snapshot.url)) {
    push(scores, "summary", 85, "url:share-preview", "summary:checker-view");
  }

  if (
    hasLink(
      snapshot,
      (link) => /Download PDF/i.test(link.text) || /\/pdf$/.test(link.href ?? "")
    ) &&
    /\b[A-Z0-9]{3}\s+[A-Z0-9]{3}\s+[A-Z0-9]{3}\b/i.test(text)
  ) {
    push(scores, "download_pdf", 100, "link:download-pdf", "body:share-code");
  }

  scores.sort((a, b) => b.confidence - a.confidence);
  const best = scores[0] ?? { kind: "unknown" as const, confidence: 0, evidence: [] };
  return {
    ...best,
    alternatives: scores.slice(1, 4),
    phase: phaseByKind[best.kind],
  };
};
