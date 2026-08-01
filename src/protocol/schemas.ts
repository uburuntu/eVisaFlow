import { z } from "zod";

const documentNumberSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/);

export const TwoFactorMethodSchema = z.enum(["sms", "email"]);

export const IdentityDocumentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("passport"), number: documentNumberSchema }),
  z.object({ type: z.literal("nationalId"), number: documentNumberSchema }),
  z.object({ type: z.literal("brc"), number: documentNumberSchema }),
  z.object({ type: z.literal("ukvi"), number: documentNumberSchema }),
]);

const dateOfBirthObjectSchema = z
  .object({
    day: z.number().int().min(1).max(31),
    month: z.number().int().min(1).max(12),
    year: z.number().int().min(1900).max(2100),
  })
  .refine(({ day, month, year }) => {
    const value = new Date(Date.UTC(year, month - 1, day));
    return (
      value.getUTCFullYear() === year &&
      value.getUTCMonth() === month - 1 &&
      value.getUTCDate() === day
    );
  }, "Invalid calendar date");

export const DateOfBirthSchema = z.union([z.iso.date(), dateOfBirthObjectSchema]);

export const ApplicantSchema = z.object({
  identityDocument: IdentityDocumentSchema,
  dateOfBirth: DateOfBirthSchema,
});

export const PurposeSchema = z.enum([
  "right_to_work",
  "right_to_rent",
  "immigration_status_other",
]);

export const AuthorityBasisSchema = z.enum([
  "self",
  "parent_or_guardian",
  "authorised_proxy",
]);

export const MobileRunStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_2fa",
  "packaging",
  "succeeded",
  "partial_success",
  "failed",
  "cancelled",
  "interrupted",
  "expired",
]);

export const MobileArtifactKindSchema = z.enum([
  "evisa_pdf",
  "checker_html",
  "checker_pdf",
]);

export const MobileProfileSchema = z.object({
  id: z.uuid(),
  displayName: z.string().trim().min(1).max(60),
  applicant: ApplicantSchema,
  preferredTwoFactorMethod: TwoFactorMethodSchema,
  authorityBasis: AuthorityBasisSchema,
  attestedAt: z.iso.datetime(),
  termsVersion: z.string().trim().min(1).max(32),
  lastPurpose: PurposeSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const MobileRunCreateRequestSchema = z.object({
  clientRunId: z.uuid(),
  profileId: z.uuid(),
  applicant: ApplicantSchema,
  purpose: PurposeSchema,
  preferredTwoFactorMethod: TwoFactorMethodSchema,
  authorityBasis: AuthorityBasisSchema,
  attestedAt: z.iso.datetime(),
  termsVersion: z.string().trim().min(1).max(32),
});
