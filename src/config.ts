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

const IdentityDocumentSchema = z.object({
  type: z.enum(["passport", "nationalId", "brc", "ukvi"]),
  number: z.string().min(3),
});

const DateOfBirthSchema = z.union([
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  z.object({
    day: z.number().int().min(1).max(31),
    month: z.number().int().min(1).max(12),
    year: z.number().int().min(1900).max(2100),
  }),
]);

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
      diagnostics: z
        .object({
          mode: z.enum(["off", "sanitized", "raw"]).optional(),
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
