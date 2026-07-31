export const PURPOSE_LABELS = {
  right_to_work: "To prove my right to work",
  right_to_rent: "To prove my right to rent in England",
  immigration_status_other: "To prove my immigration status for anything else",
} as const;

export const DOC_TYPE_LABELS = {
  passport: "Passport",
  nationalId: "National identity card",
  brc: "Biometric residence card or permit",
  ukvi: "I use a UKVI customer number",
} as const;

export const DOC_NUMBER_LABELS = {
  passport: "Passport number",
  nationalId: "National identity card number",
  brc: "Biometric residence card or permit number",
  ukvi: "UKVI customer number",
} as const;
