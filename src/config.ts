import { z } from "zod";

const AuthMethodSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("passport"),
    passportNumber: z.string().min(3),
  }),
  z.object({
    type: z.literal("nationalId"),
    idNumber: z.string().min(3),
  }),
  z.object({
    type: z.literal("brc"),
    cardNumber: z.string().min(3),
  }),
  z.object({
    type: z.literal("ukvi"),
    customerNumber: z.string().min(3),
  }),
]);

export const ConfigSchema = z.object({
  credentials: z.object({
    auth: AuthMethodSchema,
    dateOfBirth: z.object({
      day: z.number().int().min(1).max(31),
      month: z.number().int().min(1).max(12),
      year: z.number().int().min(1900).max(2100),
    }),
    preferredTwoFactorMethod: z.enum(["sms", "email"]).optional(),
  }),
  purpose: z
    .enum(["right_to_work", "right_to_rent", "immigration_status_other"])
    .optional(),
  options: z
    .object({
      headless: z.boolean().optional(),
      verbose: z.boolean().optional(),
      screenshotOnError: z.boolean().optional(),
      outputDir: z.string().optional(),
      outputFile: z.string().optional(),
      userDataDir: z.string().optional(),
      navigationTimeoutMs: z.number().int().positive().optional(),
      actionTimeoutMs: z.number().int().positive().optional(),
      twoFactorTimeoutMs: z.number().int().positive().optional(),
    })
    .optional(),
});

export type ConfigFile = z.infer<typeof ConfigSchema>;
