/**
 * Human-readable labels for the enum-ish values the API and member secrets use,
 * plus a couple of small formatters. Centralised so the dashboard, run screen,
 * and history all phrase things the same way for a non-technical, ESL audience.
 */
import type { DocumentType, Purpose, TwoFactorMethod } from "./member-secret.js";

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  passport: "Passport",
  nationalId: "National identity card",
  brc: "Biometric residence card",
  ukvi: "UKVI account number",
};

export const PURPOSE_LABELS: Record<Purpose, string> = {
  right_to_work: "Prove right to work",
  right_to_rent: "Prove right to rent",
  immigration_status_other: "View immigration status",
};

export const TWO_FACTOR_LABELS: Record<TwoFactorMethod, string> = {
  sms: "Text message (SMS)",
  email: "Email",
};

/** Run status → {label, tone} for badges. Covers DB + live statuses. */
export function runStatusInfo(status: string): {
  label: string;
  tone: "info" | "success" | "error" | "neutral";
} {
  switch (status) {
    case "queued":
      return { label: "Queued", tone: "info" };
    case "running":
      return { label: "Running", tone: "info" };
    case "awaiting_2fa":
      return { label: "Awaiting code", tone: "info" };
    case "success":
    case "completed":
      return { label: "Completed", tone: "success" };
    case "failed":
      return { label: "Failed", tone: "error" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
    case "interrupted":
      return { label: "Interrupted", tone: "error" };
    default:
      return { label: status, tone: "neutral" };
  }
}

/** Formats an ISO timestamp as a short local date+time, falling back to the raw string. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Formats an ISO date as a short local date (no time) — for validity dates. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Masks all but the last few characters of a document number for display. */
export function maskDocumentNumber(value: string): string {
  const tail = value.slice(-3);
  const hidden = Math.max(0, value.length - 3);
  return `${"•".repeat(Math.min(hidden, 8))}${tail}`;
}
