import { z } from "zod";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  SUPABASE_URL: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ENCRYPTION_KEY: z
    .string()
    .length(64)
    .regex(/^[0-9a-f]+$/i, "Must be 64 hex characters (32 bytes)"),
  QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
  EVISA_OUTPUT_DIR: z.string().default("./downloads"),
  EVISA_HEADLESS: z.coerce.boolean().default(true),
  SCHEDULER_CRON: z.string().default("0 9 * * *"),
  SCHEDULE_INTERVAL_DAYS: z.coerce.number().int().min(1).default(30),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  cached = envSchema.parse(process.env);
  return cached;
}
