const MONTHS = new Map(
  [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].map((month, index) => [month, index])
);

export const sanitizeSegment = (value: string | undefined): string => {
  const input = (value ?? "").trim();
  if (!input) {
    return "UNKNOWN";
  }

  const sanitized = input
    .normalize("NFKD")
    .replace(/[^\p{ASCII}]/gu, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return sanitized || "UNKNOWN";
};

export const splitName = (
  rawName: string | undefined
): { givenName: string; surname: string } => {
  const name = (rawName ?? "").trim();
  if (!name) {
    return { givenName: "UNKNOWN", surname: "UNKNOWN" };
  }

  if (name.includes(",")) {
    const [surname, givenNames] = name.split(",", 2).map((part) => part.trim());
    return {
      givenName: givenNames?.split(/\s+/).filter(Boolean)[0] ?? "UNKNOWN",
      surname: surname || "UNKNOWN",
    };
  }

  const parts = name.split(/\s+/).filter(Boolean);
  const surname = parts.length > 1 ? parts.at(-1) : parts[0];
  return {
    givenName: parts[0] ?? "UNKNOWN",
    surname: surname ?? "UNKNOWN",
  };
};

export const formatArtifactDateSegment = (
  date: Date | undefined,
  capturedAt: Date = new Date()
): string => {
  // Indefinite statuses have no expiry; their capture date keeps filenames sortable.
  const resolved = date && !Number.isNaN(date.getTime()) ? date : capturedAt;
  return Number.isNaN(resolved.getTime())
    ? "UNKNOWN"
    : resolved.toISOString().slice(0, 10);
};

export const parseGovUkDate = (value: string | undefined): Date | undefined => {
  const match = value
    ?.trim()
    .match(
      /^(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/i
    );
  if (!match) {
    return undefined;
  }

  const day = Number(match[1]);
  const monthName = match[2]?.toLowerCase();
  const month = monthName ? MONTHS.get(monthName) : undefined;
  const year = Number(match[3]);
  if (month === undefined || !Number.isInteger(day) || !Number.isInteger(year)) {
    return undefined;
  }

  const date = new Date(Date.UTC(year, month, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date;
};
