import cron from "node-cron";
import { z } from "zod";

const parseBoolean = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return value;
};

const BooleanFromEnv = z.preprocess(
  parseBoolean,
  z.boolean({ error: "Expected true/false, 1/0, yes/no, or on/off" })
);

const DiagnosticsModeSchema = z.enum(["off", "sanitized", "raw", "sanitized_on_failure"]);

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ENCRYPTION_KEY: z
    .string()
    .length(64)
    .regex(/^[0-9a-f]+$/i, "Must be 64 hex characters (32 bytes)"),
  QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
  EVISA_HEADLESS: BooleanFromEnv.default(true),
  EVISA_DIAGNOSTICS_MODE: DiagnosticsModeSchema.default("sanitized_on_failure"),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  MOBILE_API_PORT: z.coerce.number().int().min(1).max(65_535).default(8090),
  MOBILE_API_HOST: z.string().trim().min(1).default("0.0.0.0"),
  SCHEDULER_CRON: z
    .string()
    .default("0 9 * * *")
    .refine((value) => cron.validate(value), "Invalid cron expression"),
  SCHEDULE_INTERVAL_DAYS: z.coerce.number().int().min(1).default(30),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${details}`);
  }
  cached = parsed.data;
  return cached;
}

export function redactedEnvSummary(env: Env): Record<string, unknown> {
  return {
    supabaseUrl: env.SUPABASE_URL,
    queueConcurrency: env.QUEUE_CONCURRENCY,
    evisaHeadless: env.EVISA_HEADLESS,
    diagnosticsMode: env.EVISA_DIAGNOSTICS_MODE,
    healthPort: env.HEALTH_PORT,
    mobileApiPort: env.MOBILE_API_PORT,
    mobileApiHost: env.MOBILE_API_HOST,
    schedulerCron: env.SCHEDULER_CRON,
    scheduleIntervalDays: env.SCHEDULE_INTERVAL_DAYS,
  };
}
