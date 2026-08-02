import type {
  AuthorityBasis,
  IdentityDocument,
  TwoFactorMethod,
} from "@evisa-flow/protocol";

export const documentTypeLabels: Record<IdentityDocument["type"], string> = {
  passport: "Passport",
  nationalId: "National ID",
  brc: "Biometric residence card",
  ukvi: "UKVI customer number",
};

export const authorityLabels: Record<AuthorityBasis, string> = {
  self: "Myself",
  parent_or_guardian: "Parent or guardian",
  authorised_proxy: "Authorised by this person",
};

export const twoFactorLabels: Record<TwoFactorMethod, string> = {
  sms: "Text message",
  email: "Email",
};

export function maskDocumentNumber(value: string): string {
  const suffix = value.slice(-4);
  return `**** ${suffix}`;
}

export function formatDateOfBirth(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
