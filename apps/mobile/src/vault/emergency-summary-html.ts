import {
  formatShareCodeValidUntil,
  type MobileProfile,
  type Purpose,
} from "@evisa-flow/protocol";
import { OFFICIAL_EVISA_URL } from "../constants/app";
import type { SavedResult } from "./vault";

interface SummaryItem {
  profile?: MobileProfile;
  result: SavedResult;
}

const purposeLabels: Record<Purpose, string> = {
  right_to_work: "Right to work",
  right_to_rent: "Right to rent",
  immigration_status_other: "Other status check",
};

export function emergencySummaryHtml(
  items: SummaryItem[],
  createdAtValue = new Date().toISOString()
): string {
  const createdAt = formatDateTime(createdAtValue);
  const sections = items
    .map(({ profile, result }) => {
      const validUntil = result.validUntil
        ? formatShareCodeValidUntil(result.validUntil, { dateStyle: "long" })
        : "Not supplied";
      return `
        <section class="proof">
          <h2>${escapeHtml(profile?.displayName ?? "Saved eVisa")}</h2>
          <p class="purpose">${escapeHtml(purposeLabels[result.purpose])}</p>
          <div class="code-label">SHARE CODE</div>
          <div class="code">${escapeHtml(result.shareCode)}</div>
          <dl>
            <dt>Share code valid until</dt><dd>${escapeHtml(validUntil)}</dd>
            <dt>Last checked online</dt><dd>${escapeHtml(formatDateTime(result.generatedAt ?? result.savedAt))}</dd>
            <dt>Saved on this phone</dt><dd>${escapeHtml(formatDateTime(result.savedAt))}</dd>
          </dl>
        </section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    @page { margin: 18mm; }
    body { color: #18201f; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 11pt; line-height: 1.45; }
    header { border-bottom: 2px solid #126b5b; margin-bottom: 18px; padding-bottom: 12px; }
    h1 { font-size: 22pt; margin: 0 0 4px; }
    .subtitle, .purpose, .created { color: #5d6866; }
    .created { font-size: 9pt; margin-top: 8px; }
    .warning { border: 1px solid #d5dddb; margin: 0 0 18px; padding: 12px; }
    .proof { break-inside: avoid; border-top: 1px solid #d5dddb; margin-top: 18px; padding-top: 16px; }
    h2 { font-size: 17pt; margin: 0; }
    .purpose { margin: 3px 0 14px; }
    .code-label { color: #5d6866; font-size: 8pt; font-weight: 700; }
    .code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 24pt; font-weight: 700; letter-spacing: 0; margin: 2px 0 14px; }
    dl { display: grid; grid-template-columns: 1fr 1fr; margin: 0; }
    dt, dd { border-top: 1px solid #edf1f2; margin: 0; padding: 7px 0; }
    dd { font-weight: 600; text-align: right; }
    footer { border-top: 1px solid #d5dddb; font-size: 9pt; margin-top: 24px; padding-top: 12px; }
    a { color: #126b5b; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <header>
    <h1>eVisaFlow offline summary</h1>
    <div class="subtitle">Independent, unofficial convenience copy</div>
    <div class="created">Created ${escapeHtml(createdAt)}</div>
  </header>
  <div class="warning">
    This saved summary is not a live UKVI check and may be out of date. It does not replace a passport or travel document, the official UKVI record, or verification by a carrier, employer, landlord, or border official.
  </div>
  ${sections}
  <footer>
    The official GOV.UK eVisa and share-code service is free:<br>
    <a href="${OFFICIAL_EVISA_URL}">${OFFICIAL_EVISA_URL}</a>
  </footer>
</body>
</html>`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(value));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
