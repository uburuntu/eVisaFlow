-- 004_web_identity: web auth identity (email magic-link + Telegram login),
-- client-held-key vault, sessions, and magic-link tokens.
--
-- ADDITIVE and IDEMPOTENT: every statement is guarded so re-running is a no-op
-- and the existing bot rows are untouched. Existing users keep their telegram_id;
-- web users will instead carry an email. The CHECK guarantees every user is
-- reachable by at least one identity.

-- ============================================================
-- USERS — relax Telegram-only assumptions, add web identity
-- ============================================================

-- Telegram is no longer mandatory (web users have none). UNIQUE is retained by
-- the original `telegram_id BIGINT NOT NULL UNIQUE` column constraint, which the
-- NOT NULL drop leaves in place. Postgres treats multiple NULLs as distinct, so
-- web users with NULL telegram_id do not collide.
ALTER TABLE users ALTER COLUMN telegram_id DROP NOT NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email          TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS display_name   TEXT;

-- Backfill a display name for existing rows before first_name becomes optional.
UPDATE users SET display_name = first_name WHERE display_name IS NULL;

-- first_name was Telegram-derived and mandatory; web sign-up has no first name.
ALTER TABLE users ALTER COLUMN first_name DROP NOT NULL;

-- Every user must be reachable by at least one identity. Guarded so a re-run
-- does not error on the already-present constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_identity_present_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_identity_present_check
      CHECK (telegram_id IS NOT NULL OR email IS NOT NULL);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ============================================================
-- USER VAULT — client-held-key crypto material (1:1, optional)
-- ============================================================
-- Opaque blobs the server stores but cannot read: the X25519 public key, the
-- password-wrapped private key, the Argon2id KDF salt/params, and a second copy
-- of the private key wrapped by the recovery kit. Server has no passphrase.
CREATE TABLE IF NOT EXISTS user_vault (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  public_key           BYTEA NOT NULL,
  wrapped_private_key  BYTEA NOT NULL,
  kdf_salt             BYTEA NOT NULL,
  kdf_params           JSONB NOT NULL DEFAULT '{}'::jsonb,
  recovery_wrapped_key BYTEA,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- SESSIONS — hashed bearer tokens for the web app
-- ============================================================
-- Only the hash of the session token is stored; the raw token lives in the
-- HttpOnly cookie. Lookups are by token_hash; expired rows are pruned by cron.
CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ============================================================
-- MAGIC LINK TOKENS — single-use, short-TTL email sign-in
-- ============================================================
-- Stores only the token hash; `consumed_at` enforces single use and `expires_at`
-- bounds the TTL. Both consumed and expired rows are pruned by cron.
CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_email ON magic_link_tokens(email);
CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_expires ON magic_link_tokens(expires_at);

-- ============================================================
-- Reuse existing updated_at trigger + enable RLS on new tables
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_user_vault_updated_at'
  ) THEN
    CREATE TRIGGER trg_user_vault_updated_at
      BEFORE UPDATE ON user_vault
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END;
$$;

ALTER TABLE user_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE magic_link_tokens ENABLE ROW LEVEL SECURITY;
