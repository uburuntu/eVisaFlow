import { z } from "zod";

const PdfFileArtifactSchema = z
  .object({
    mode: z.literal("file").optional(),
    directory: z.string().optional(),
    path: z.string().optional(),
  })
  .strict();

const PdfBytesArtifactSchema = z
  .object({
    mode: z.literal("bytes"),
    maxBytes: z.number().int().positive().optional(),
  })
  .strict();

const HtmlFileArtifactSchema = z
  .object({
    mode: z.literal("file").optional(),
    directory: z.string().optional(),
    path: z.string().optional(),
    maxBytes: z.number().int().positive().optional(),
    inlineImages: z.boolean().optional(),
    inlineStyles: z.boolean().optional(),
  })
  .strict();

const HtmlBytesArtifactSchema = z
  .object({
    mode: z.literal("bytes"),
    maxBytes: z.number().int().positive().optional(),
    inlineImages: z.boolean().optional(),
    inlineStyles: z.boolean().optional(),
  })
  .strict();

const CheckerArtifactSchema = z.union([
  z.boolean(),
  z
    .object({
      html: z
        .union([z.boolean(), HtmlFileArtifactSchema, HtmlBytesArtifactSchema])
        .optional(),
      pdf: z
        .union([z.boolean(), PdfFileArtifactSchema, PdfBytesArtifactSchema])
        .optional(),
    })
    .strict(),
]);

const DiagnosticsModeSchema = z.preprocess(
  (value) => (value === "on" ? "sanitized" : value),
  z.enum(["off", "sanitized", "raw", "sanitized_on_failure"])
);

const IdentityDocumentSchema = z.object({
  type: z.enum(["passport", "nationalId", "brc", "ukvi"]),
  number: z.string().min(3),
});

const isCalendarDate = (value: { day: number; month: number; year: number }): boolean => {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day));
  return (
    date.getUTCFullYear() === value.year &&
    date.getUTCMonth() === value.month - 1 &&
    date.getUTCDate() === value.day
  );
};

const DateOfBirthSchema = z.union([
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  z
    .object({
      day: z.number().int().min(1).max(31),
      month: z.number().int().min(1).max(12),
      year: z.number().int().min(1900).max(2100),
    })
    .refine(isCalendarDate, "dateOfBirth must be a valid calendar date"),
]);

const ShareCodeCheckDetailsSchema = z
  .object({
    jobTitle: z.string().min(1).optional(),
    organisation: z.string().min(1).optional(),
    purpose: z
      .enum([
        "driving_licence",
        "student_loan",
        "education_or_training",
        "travel",
        "health_insurance_card",
        "personal_finance",
        "homelessness_or_council_housing",
        "other",
      ])
      .optional(),
    otherPurpose: z.string().min(1).optional(),
  })
  .strict();

export const ApplicantSchema = z.object({
  identityDocument: IdentityDocumentSchema,
  dateOfBirth: DateOfBirthSchema,
});

export const ConfigSchema = z.object({
  applicant: ApplicantSchema.optional(),
  purpose: z
    .enum(["right_to_work", "right_to_rent", "immigration_status_other"])
    .optional(),
  challengePreference: z
    .object({
      deliveryMethod: z.enum(["sms", "email"]).optional(),
    })
    .optional(),
  checkDetails: ShareCodeCheckDetailsSchema.optional(),
  browser: z
    .object({
      headless: z.boolean().optional(),
      userDataDir: z.string().optional(),
    })
    .optional(),
  artifacts: z
    .object({
      pdf: z
        .union([z.boolean(), PdfFileArtifactSchema, PdfBytesArtifactSchema])
        .optional(),
      checker: CheckerArtifactSchema.optional(),
      diagnostics: z
        .object({
          mode: DiagnosticsModeSchema.optional(),
          directory: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  timeouts: z
    .object({
      navigationMs: z.number().int().positive().optional(),
      actionMs: z.number().int().positive().optional(),
      twoFactorMs: z.number().int().positive().optional(),
    })
    .optional(),
  verbose: z.boolean().optional(),
});

export type ConfigFile = z.infer<typeof ConfigSchema>;
