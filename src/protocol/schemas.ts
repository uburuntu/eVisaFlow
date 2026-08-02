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

export const MobileEntitlementSchema = z.enum(["free", "evisaflow_pro"]);

export const MobileServiceStatusSchema = z.enum(["available", "maintenance"]);

export const ShareCodeValidUntilSchema = z.union([z.iso.date(), z.iso.datetime()]);

export const EVisaPhaseSchema = z.enum([
  "launching",
  "verifying_identity",
  "choosing_2fa",
  "waiting_for_2fa",
  "viewing_status",
  "creating_share_code",
  "downloading_pdf",
  "checking_status",
  "capturing_checker_html",
  "downloading_checker_pdf",
  "completed",
  "failed",
]);

export const EVisaChallengeSchema = z.object({
  type: z.literal("security_code"),
  deliveryMethod: TwoFactorMethodSchema,
  deadlineMs: z.number().int().positive(),
});

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

export const MobileArtifactDescriptorSchema = z.object({
  id: z.uuid(),
  kind: MobileArtifactKindSchema,
  filename: z.string().trim().min(1).max(240),
  contentType: z.enum(["application/pdf", "text/html"]),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const MobileRunSnapshotSchema = z.object({
  id: z.uuid(),
  clientRunId: z.uuid(),
  profileId: z.uuid(),
  purpose: PurposeSchema,
  status: MobileRunStatusSchema,
  phase: EVisaPhaseSchema.optional(),
  challenge: EVisaChallengeSchema.optional(),
  retryable: z.boolean().optional(),
  errorCode: z.string().trim().min(1).max(80).optional(),
  artifacts: z.array(MobileArtifactDescriptorSchema).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const MobileClaimTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const MobileClaimManifestHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const MobileRunClaimSessionSchema = z.object({
  claimToken: MobileClaimTokenSchema,
  claimExpiresAt: z.iso.datetime(),
  manifestHash: MobileClaimManifestHashSchema,
  shareCode: z.string().trim().min(1).max(32),
  validUntil: ShareCodeValidUntilSchema.optional(),
  generatedAt: z.iso.datetime(),
  artifacts: z.array(MobileArtifactDescriptorSchema),
});

/** @deprecated Use MobileRunClaimSessionSchema. */
export const MobileRunClaimResultSchema = MobileRunClaimSessionSchema;

export const MobileRunClaimAcknowledgementRequestSchema = z.object({
  claimToken: MobileClaimTokenSchema,
  manifestHash: MobileClaimManifestHashSchema,
});

export const MobileRunClaimAcknowledgementSchema = z.object({
  claimedAt: z.iso.datetime(),
  usageConsumed: z.boolean(),
});

export const MobileMeSchema = z.object({
  userId: z.uuid(),
  entitlement: MobileEntitlementSchema,
  profileLimit: z.number().int().min(1).max(100),
  activeProfileCount: z.number().int().nonnegative(),
  successfulRunCount: z.number().int().nonnegative(),
  remainingFreeRuns: z.number().int().nonnegative().nullable(),
  serviceStatus: MobileServiceStatusSchema,
  serviceMessage: z.string().trim().min(1).max(240).optional(),
});

export const MobileProfileSlotRequestSchema = z.object({
  profileId: z.uuid(),
});

export const MobileChallengeSubmissionSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/),
});

export const MobileRunEventSchema = z.object({
  id: z.number().int().nonnegative(),
  runId: z.uuid(),
  type: z.string().trim().min(1).max(80),
  phase: EVisaPhaseSchema.optional(),
  message: z.string().trim().min(1).max(240).optional(),
  createdAt: z.iso.datetime(),
});

export const MobileApiErrorSchema = z.object({
  code: z.string().trim().min(1).max(80),
  message: z.string().trim().min(1).max(240),
  retryable: z.boolean(),
});
