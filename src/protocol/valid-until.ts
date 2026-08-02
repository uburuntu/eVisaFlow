const ISO_DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function shareCodeExpiryDeadlineMs(validUntil: string): number {
  return Date.parse(
    ISO_DATE_ONLY_PATTERN.test(validUntil) ? `${validUntil}T23:59:59.999Z` : validUntil
  );
}

export function formatShareCodeValidUntil(
  validUntil: string,
  options: Intl.DateTimeFormatOptions,
  locale = "en-GB"
): string {
  const dateOnly = ISO_DATE_ONLY_PATTERN.test(validUntil);
  const value = new Date(dateOnly ? `${validUntil}T00:00:00.000Z` : validUntil);
  return new Intl.DateTimeFormat(locale, {
    ...options,
    ...(dateOnly ? { timeZone: "UTC" } : {}),
  }).format(value);
}
