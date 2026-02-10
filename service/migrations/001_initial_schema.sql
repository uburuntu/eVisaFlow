CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id       BIGINT NOT NULL UNIQUE,
  telegram_handle   TEXT,
  first_name        TEXT NOT NULL,
  next_scheduled_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_telegram_id ON users(telegram_id);
CREATE INDEX idx_users_next_scheduled ON users(next_scheduled_at);

-- ============================================================
-- FAMILY MEMBERS
-- ============================================================
CREATE TABLE family_members (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name          TEXT NOT NULL,
  auth_type             TEXT NOT NULL CHECK (auth_type IN ('passport', 'nationalId', 'brc', 'ukvi')),
  encrypted_doc_number  TEXT NOT NULL,
  dob_day               SMALLINT NOT NULL CHECK (dob_day BETWEEN 1 AND 31),
  dob_month             SMALLINT NOT NULL CHECK (dob_month BETWEEN 1 AND 12),
  dob_year              SMALLINT NOT NULL CHECK (dob_year BETWEEN 1900 AND 2100),
  preferred_2fa_method  TEXT NOT NULL DEFAULT 'sms' CHECK (preferred_2fa_method IN ('sms', 'email')),
  purpose               TEXT NOT NULL DEFAULT 'immigration_status_other'
                        CHECK (purpose IN ('right_to_work', 'right_to_rent', 'immigration_status_other')),
  is_active             BOOLEAN NOT NULL DEFAULT true,
  sort_order            SMALLINT NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_family_members_user ON family_members(user_id);

-- Max 6 active family members per user
CREATE OR REPLACE FUNCTION check_max_family_members()
  RETURNS TRIGGER AS $$
BEGIN
  IF (
    SELECT count(*) FROM family_members
    WHERE user_id = NEW.user_id AND is_active = true
  ) >= 6 THEN
    RAISE EXCEPTION 'Maximum 6 active family members per user';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_max_family_members
  BEFORE INSERT ON family_members
  FOR EACH ROW EXECUTE FUNCTION check_max_family_members();

-- ============================================================
-- RUNS (Audit Log)
-- ============================================================
CREATE TABLE runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_member_id  UUID NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  trigger           TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'scheduled')),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'awaiting_2fa', 'success', 'failed')),
  share_code        TEXT,
  valid_until       TIMESTAMPTZ,
  error_message     TEXT,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_runs_user ON runs(user_id);
CREATE INDEX idx_runs_member ON runs(family_member_id);
CREATE INDEX idx_runs_created ON runs(created_at DESC);

-- ============================================================
-- Auto-update updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
  RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_family_members_updated_at
  BEFORE UPDATE ON family_members
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- Row Level Security (service role bypasses)
-- ============================================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
