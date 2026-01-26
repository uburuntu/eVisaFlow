export const SELECTORS = {
  entryStartButton: 'a:has-text("View your eVisa and get a share code")',
  continueButton: 'button:has-text("Continue")',
  getShareCodeButton: 'button:has-text("Get share code")',
  getShareCodeWithArticleButton: 'button:has-text("Get a share code")',
  createShareCodeButton: 'button:has-text("Create a share code")',
  downloadPdfLink: 'a:has-text("Download PDF")',
  securityCodeInput: 'input[name="code"], input#code',
};

export const HEADINGS = {
  entry: "View your eVisa and get a share code",
  documentType: "Which identity document do you use to sign in to your UKVI account?",
  passportNumber: "What is your passport number?",
  nationalIdNumber: "What is your national identity card number?",
  brcNumber: "What is your biometric residence card or permit number?",
  ukviNumber: "What is your UKVI customer number?",
  dateOfBirth: "What is your date of birth?",
  twoFactorMethod: "How do you want to receive a security code?",
  twoFactorCodePhone: "Check your phone",
  twoFactorCodeEmail: "Check your email",
  status: "Your immigration status (eVisa)",
  proveStatus: "Prove your status",
  purpose: "Why do you need a share code?",
  confirmation: "Get a share code to prove your status",
  summary: "Summary of what they can do in the UK",
  details: "Details you need to share",
};

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
