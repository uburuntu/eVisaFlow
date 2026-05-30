import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Postgres `bytea` column surfaced to JS as a Node {@link Buffer}. Drizzle has no
 * first-class `bytea` builder in this version, so we declare a custom type; the
 * `pg` driver already maps `bytea` ⇄ `Buffer` on the wire. Used by the
 * client-held-key vault, whose blobs the server stores but never interprets.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Drizzle table definitions mirroring the live Postgres schema produced by
 * `service/migrations/001_initial_schema.sql` + `002` + `003`. The migration
 * files remain the source of truth for DDL (they also carry triggers and RLS
 * that Drizzle does not model): the max-6-active trigger
 * (`trg_max_family_members`) and the `update_updated_at` triggers are enforced
 * by Postgres, not here. These definitions exist so the `db/*` query modules
 * can build typed statements against the same columns.
 *
 * Timestamps use `mode: "string"` so reads surface ISO-8601 strings, matching
 * the `DbUser`/`DbFamilyMember`/`DbRun` string timestamp fields the rest of the
 * service already depends on. `telegram_id` is a `bigint` exposed as a JS
 * number (`mode: "number"`) to match `DbUser.telegram_id`.
 */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // telegram_id is nullable since 004 (web users have none) but keeps UNIQUE.
    telegramId: bigint("telegram_id", { mode: "number" }).unique(),
    telegramHandle: text("telegram_handle"),
    // first_name became nullable in 004; web sign-up has no Telegram first name.
    firstName: text("first_name"),
    email: text("email").unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    displayName: text("display_name"),
    nextScheduledAt: timestamp("next_scheduled_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_users_telegram_id").on(table.telegramId),
    index("idx_users_email").on(table.email),
    index("idx_users_next_scheduled").on(table.nextScheduledAt),
    check(
      "users_identity_present_check",
      sql`${table.telegramId} IS NOT NULL OR ${table.email} IS NOT NULL`
    ),
  ]
);

export const familyMembers = pgTable(
  "family_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    authType: text("auth_type").notNull(),
    encryptedDocNumber: text("encrypted_doc_number").notNull(),
    dobDay: smallint("dob_day").notNull(),
    dobMonth: smallint("dob_month").notNull(),
    dobYear: smallint("dob_year").notNull(),
    preferred2faMethod: text("preferred_2fa_method").notNull().default("sms"),
    purpose: text("purpose").notNull().default("immigration_status_other"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: smallint("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_family_members_user").on(table.userId),
    check(
      "family_members_auth_type_check",
      sql`${table.authType} IN ('passport', 'nationalId', 'brc', 'ukvi')`
    ),
    check("family_members_dob_day_check", sql`${table.dobDay} BETWEEN 1 AND 31`),
    check("family_members_dob_month_check", sql`${table.dobMonth} BETWEEN 1 AND 12`),
    check("family_members_dob_year_check", sql`${table.dobYear} BETWEEN 1900 AND 2100`),
    check(
      "family_members_preferred_2fa_method_check",
      sql`${table.preferred2faMethod} IN ('sms', 'email')`
    ),
    check(
      "family_members_purpose_check",
      sql`${table.purpose} IN ('right_to_work', 'right_to_rent', 'immigration_status_other')`
    ),
  ]
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    familyMemberId: uuid("family_member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
    trigger: text("trigger").notNull().default("manual"),
    status: text("status").notNull().default("pending"),
    encryptedShareCode: text("encrypted_share_code"),
    validUntil: timestamp("valid_until", { withTimezone: true, mode: "string" }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_runs_user").on(table.userId),
    index("idx_runs_member").on(table.familyMemberId),
    index("idx_runs_created").on(table.createdAt.desc()),
    uniqueIndex("idx_runs_one_active_per_member")
      .on(table.userId, table.familyMemberId)
      .where(sql`${table.status} IN ('pending', 'running', 'awaiting_2fa')`),
    check("runs_trigger_check", sql`${table.trigger} IN ('manual', 'scheduled')`),
    check(
      "runs_status_check",
      sql`${table.status} IN ('pending', 'running', 'awaiting_2fa', 'success', 'failed', 'cancelled', 'interrupted')`
    ),
  ]
);

export const runEvents = pgTable(
  "run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    phase: text("phase"),
    pageKind: text("page_kind"),
    operation: text("operation"),
    durationMs: doublePrecision("duration_ms"),
    stepId: text("step_id"),
    errorCode: text("error_code"),
    message: text("message"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_run_events_run_created").on(table.runId, table.createdAt)]
);

/**
 * Client-held-key vault (1:1 with a user, optional). All blobs are opaque to the
 * server: it stores and returns them but never decrypts. Added in migration 004.
 */
export const userVault = pgTable("user_vault", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  publicKey: bytea("public_key").notNull(),
  wrappedPrivateKey: bytea("wrapped_private_key").notNull(),
  kdfSalt: bytea("kdf_salt").notNull(),
  kdfParams: jsonb("kdf_params").notNull().default(sql`'{}'::jsonb`),
  recoveryWrappedKey: bytea("recovery_wrapped_key"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

/**
 * Web session tokens. Only the hash is stored; the raw token lives in the
 * HttpOnly cookie. Added in migration 004.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    index("idx_sessions_user").on(table.userId),
    index("idx_sessions_expires").on(table.expiresAt),
  ]
);

/**
 * Single-use, short-TTL email magic-link tokens. Only the hash is stored;
 * `consumedAt` enforces single use. Added in migration 004.
 */
export const magicLinkTokens = pgTable(
  "magic_link_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    index("idx_magic_link_tokens_email").on(table.email),
    index("idx_magic_link_tokens_expires").on(table.expiresAt),
  ]
);

export const schema = {
  users,
  familyMembers,
  runs,
  runEvents,
  userVault,
  sessions,
  magicLinkTokens,
};
