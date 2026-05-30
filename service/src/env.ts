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

const DeploymentModeSchema = z.enum(["selfhost", "cloud"]);

const envSchema = z
  .object({
    // Selects the deployment profile. `selfhost` (the default) is the web-first,
    // one-`docker compose up` profile: no billing, no provider mailer, no R2 — a
    // local Postgres and the bundled web app. `cloud` is reserved for the later
    // paid tier (Stripe/quotas/R2 wiring keys off this). Defaults to `selfhost`
    // so a fresh checkout is a self-host install with zero extra config.
    DEPLOYMENT_MODE: DeploymentModeSchema.default("selfhost"),
    // Opt-in Telegram bot. Web-first: defaults to OFF so a pure-web self-host runs
    // with NO Telegram account and never touches the server encryption key (web
    // runs are client-custody). When true, the grammY bot, its 2FA reply matching,
    // the Telegram-notify scheduler, and the Telegram readiness check all turn on —
    // and TELEGRAM_BOT_TOKEN + ENCRYPTION_KEY become required (see superRefine).
    ENABLE_BOT: BooleanFromEnv.default(false),
    // Telegram bot token from @BotFather. REQUIRED ONLY when ENABLE_BOT is true
    // (enforced by the superRefine below); a pure-web deployment needs no bot, so
    // it is optional here and validated conditionally.
    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    // Portable Postgres connection string for the Drizzle + pg handle and the
    // migration runner. This is the single source of database truth: for a Supabase
    // deployment it is the project's Postgres connection string, and for self-host
    // it points at the bundled Postgres. SAFETY: only ever point this at a
    // local/ephemeral Postgres while developing or testing, never a managed
    // production database.
    DATABASE_URL: z.url(),
    // Server-custody AES key (32 bytes hex). Only the trusted Telegram bot path
    // uses server custody; web runs are client-custody and seal to the user's
    // public key, so a bot-less web deployment needs NO server key. REQUIRED ONLY
    // when ENABLE_BOT is true (enforced by the superRefine below).
    ENCRYPTION_KEY: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]+$/i, "Must be 64 hex characters (32 bytes)")
      .optional(),
    QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
    EVISA_HEADLESS: BooleanFromEnv.default(true),
    EVISA_DIAGNOSTICS_MODE: DiagnosticsModeSchema.default("sanitized_on_failure"),
    // Single port the Fastify web server binds. It also serves the health probes
    // (`/live`, `/ready`) folded in from the old standalone raw-HTTP health server,
    // so there is one listener for the API and health alike. Phase 6 updates the
    // Docker healthcheck to hit this port's `/ready`.
    PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    // DEPRECATED: retained only so existing deployments that still set HEALTH_PORT
    // load without error. Health now lives on PORT (above); this value is ignored.
    // Remove once all environments have migrated to PORT.
    HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    SCHEDULER_CRON: z
      .string()
      .default("0 9 * * *")
      .refine((value) => cron.validate(value), "Invalid cron expression"),
    SCHEDULE_INTERVAL_DAYS: z.coerce.number().int().min(1).default(30),
    // How often the cleanup cron sweeps expired run_artifacts, sessions, and
    // consumed/expired magic-link tokens. Hourly by default — frequent enough to
    // keep sealed artifacts and stale auth rows from lingering, cheap to run.
    CLEANUP_CRON: z
      .string()
      .default("0 * * * *")
      .refine((value) => cron.validate(value), "Invalid cron expression"),
    // TTL applied to sealed run artifacts at write time (expires_at = now + TTL).
    // After this the cleanup cron deletes them. 24h by default: long enough for a
    // user to fetch and decrypt their PDFs, short enough to bound at-rest storage.
    ARTIFACT_TTL_MINUTES: z.coerce.number().int().min(1).default(1440),
    // Absolute origin the app is reachable at (scheme + host[:port], no trailing
    // slash). Used to build the magic-link verification URL emailed to users, so it
    // MUST be the externally reachable base, not the bind address. Defaults to the
    // local bind URL for dev; production self-host sets it to the real origin.
    PUBLIC_BASE_URL: z
      .url()
      .default("http://localhost:8080")
      .transform((value) => value.replace(/\/+$/, "")),
    // Web session lifetime. The session cookie's Max-Age and the stored row's
    // expires_at derive from this. 30 days by default — long enough to avoid
    // frequent re-auth, bounded so abandoned sessions expire. Expressed in minutes.
    SESSION_TTL_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .default(30 * 24 * 60),
    // Magic-link token lifetime. Short by design (a bearer credential in an email):
    // 15 minutes by default. Tokens are single-use and hashed at rest regardless.
    MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().min(1).default(15),
    // Optional SMTP transport for magic-link email. When SMTP_URL is set the
    // smtpMailer is selected (and SMTP_FROM is required); otherwise a consoleMailer
    // logs the link for dev/self-host without SMTP. Telegram Login needs neither.
    SMTP_URL: z.string().min(1).optional(),
    SMTP_FROM: z.string().min(1).optional(),
    // Filesystem path to the built Astro web assets (`web/dist`) the Fastify
    // server serves at the single origin, with an SPA fallback for `/app/*`.
    // Optional: when unset, `index.ts` defaults to the workspace `web/dist`
    // resolved relative to the running module (so a built self-host image and a
    // local `node dist/index.js` both find it). Set explicitly only when the
    // bundle lives elsewhere. If the path (or its `index.html`) is absent the web
    // server degrades gracefully — the API stays up and a hint is logged.
    WEB_DIST_PATH: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.SMTP_URL && !env.SMTP_FROM) {
      ctx.addIssue({
        code: "custom",
        message: "SMTP_FROM is required when SMTP_URL is set",
        path: ["SMTP_FROM"],
      });
    }
    // The Telegram bot is the only consumer of TELEGRAM_BOT_TOKEN (to talk to the
    // Bot API) and of ENCRYPTION_KEY (server-custody AES for the bot's runs). When
    // the bot is disabled a pure-web deployment needs neither, so require them only
    // when ENABLE_BOT is true.
    if (env.ENABLE_BOT) {
      if (!env.TELEGRAM_BOT_TOKEN) {
        ctx.addIssue({
          code: "custom",
          message: "TELEGRAM_BOT_TOKEN is required when ENABLE_BOT is true",
          path: ["TELEGRAM_BOT_TOKEN"],
        });
      }
      if (!env.ENCRYPTION_KEY) {
        ctx.addIssue({
          code: "custom",
          message: "ENCRYPTION_KEY is required when ENABLE_BOT is true",
          path: ["ENCRYPTION_KEY"],
        });
      }
    }
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

/** Extracts `host:port/database` from a connection string, dropping credentials. */
function safeDbHost(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    const db = url.pathname.replace(/^\//, "");
    return db ? `${url.host}/${db}` : url.host;
  } catch {
    return "<unparseable>";
  }
}

export function redactedEnvSummary(env: Env): Record<string, unknown> {
  return {
    deploymentMode: env.DEPLOYMENT_MODE,
    // Whether the opt-in Telegram bot is enabled. Reported (not the token) so the
    // boot log shows the deployment shape — a bot-less web deployment vs. one with
    // the Telegram channel — without leaking the credential.
    botEnabled: env.ENABLE_BOT,
    databaseHost: safeDbHost(env.DATABASE_URL),
    queueConcurrency: env.QUEUE_CONCURRENCY,
    evisaHeadless: env.EVISA_HEADLESS,
    diagnosticsMode: env.EVISA_DIAGNOSTICS_MODE,
    port: env.PORT,
    schedulerCron: env.SCHEDULER_CRON,
    scheduleIntervalDays: env.SCHEDULE_INTERVAL_DAYS,
    cleanupCron: env.CLEANUP_CRON,
    artifactTtlMinutes: env.ARTIFACT_TTL_MINUTES,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    sessionTtlMinutes: env.SESSION_TTL_MINUTES,
    magicLinkTtlMinutes: env.MAGIC_LINK_TTL_MINUTES,
    // SMTP_URL/SMTP_FROM may embed credentials, so report only whether email is
    // configured (which mailer the app selected), never the values themselves.
    mailer: env.SMTP_URL ? "smtp" : "console",
    // Report whether an explicit web-dist override is set; the resolved default
    // path is logged separately by the static-asset registrar at boot.
    webDistPath: env.WEB_DIST_PATH ?? "(default)",
  };
}
