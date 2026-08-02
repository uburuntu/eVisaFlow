CREATE TABLE mobile_users (
  id                    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  entitlement           TEXT NOT NULL DEFAULT 'free'
                        CHECK (entitlement IN ('free', 'evisaflow_pro')),
  successful_run_count  INTEGER NOT NULL DEFAULT 0 CHECK (successful_run_count >= 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mobile_profile_slots (
  id          UUID NOT NULL,
  user_id     UUID NOT NULL REFERENCES mobile_users(id) ON DELETE CASCADE,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

CREATE INDEX idx_mobile_profile_slots_user
  ON mobile_profile_slots(user_id)
  WHERE is_active = true;

CREATE OR REPLACE FUNCTION check_mobile_profile_limit()
  RETURNS TRIGGER AS $$
DECLARE
  current_entitlement TEXT;
  active_count INTEGER;
  allowed_count INTEGER;
BEGIN
  IF NEW.is_active = false THEN
    RETURN NEW;
  END IF;

  SELECT entitlement INTO current_entitlement
  FROM mobile_users
  WHERE id = NEW.user_id
  FOR UPDATE;

  allowed_count := CASE WHEN current_entitlement = 'evisaflow_pro' THEN 6 ELSE 1 END;
  SELECT count(*) INTO active_count
  FROM mobile_profile_slots
  WHERE user_id = NEW.user_id
    AND is_active = true
    AND id <> NEW.id;

  IF active_count >= allowed_count THEN
    RAISE EXCEPTION 'Mobile profile limit reached' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_mobile_profile_limit
  BEFORE INSERT OR UPDATE OF is_active ON mobile_profile_slots
  FOR EACH ROW EXECUTE FUNCTION check_mobile_profile_limit();

CREATE TABLE mobile_runs (
  id                       UUID PRIMARY KEY,
  user_id                  UUID NOT NULL REFERENCES mobile_users(id) ON DELETE CASCADE,
  profile_id               UUID NOT NULL,
  purpose                  TEXT NOT NULL
                           CHECK (purpose IN ('right_to_work', 'right_to_rent', 'immigration_status_other')),
  status                   TEXT NOT NULL DEFAULT 'queued'
                           CHECK (status IN (
                             'queued', 'running', 'awaiting_2fa', 'packaging',
                             'succeeded', 'partial_success', 'failed', 'cancelled',
                             'interrupted', 'expired'
                           )),
  phase                    TEXT,
  encrypted_request        TEXT,
  encrypted_result         TEXT,
  challenge_method         TEXT CHECK (challenge_method IN ('sms', 'email')),
  challenge_deadline       TIMESTAMPTZ,
  retryable                BOOLEAN,
  error_code               TEXT,
  started_at               TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  claimed_at               TIMESTAMPTZ,
  expires_at               TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '1 hour'),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, profile_id)
    REFERENCES mobile_profile_slots(user_id, id)
);

CREATE UNIQUE INDEX idx_mobile_runs_one_active_per_user
  ON mobile_runs(user_id)
  WHERE status IN ('queued', 'running', 'awaiting_2fa', 'packaging');

CREATE INDEX idx_mobile_runs_user_created
  ON mobile_runs(user_id, created_at DESC);

CREATE TABLE mobile_run_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id      UUID NOT NULL REFERENCES mobile_runs(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  phase       TEXT,
  message     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mobile_run_events_run_id
  ON mobile_run_events(run_id, id);

CREATE TABLE mobile_run_artifacts (
  id            UUID PRIMARY KEY,
  run_id        UUID NOT NULL REFERENCES mobile_runs(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('evisa_pdf', 'checker_html', 'checker_pdf')),
  storage_path  TEXT NOT NULL UNIQUE,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL CHECK (content_type IN ('application/pdf', 'text/html')),
  byte_length   INTEGER NOT NULL CHECK (byte_length >= 0),
  sha256        TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mobile_run_artifacts_run
  ON mobile_run_artifacts(run_id);

CREATE TABLE mobile_service_flags (
  id              BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  status          TEXT NOT NULL DEFAULT 'available'
                  CHECK (status IN ('available', 'maintenance')),
  public_message  TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO mobile_service_flags (id)
VALUES (true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'mobile-run-artifacts',
  'mobile-run-artifacts',
  false,
  -- Standalone checker HTML is capped at 20 MiB before AES-GCM encryption.
  26214400,
  ARRAY['application/octet-stream']
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE TRIGGER trg_mobile_users_updated_at
  BEFORE UPDATE ON mobile_users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_mobile_profile_slots_updated_at
  BEFORE UPDATE ON mobile_profile_slots
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_mobile_runs_updated_at
  BEFORE UPDATE ON mobile_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE mobile_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_profile_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_run_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_service_flags ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION claim_mobile_run(claim_run_id UUID, claim_user_id UUID)
  RETURNS BOOLEAN AS $$
DECLARE
  claimed_status TEXT;
BEGIN
  UPDATE mobile_runs
  SET claimed_at = now()
  WHERE id = claim_run_id
    AND user_id = claim_user_id
    AND status IN ('succeeded', 'partial_success')
    AND claimed_at IS NULL
    AND expires_at > now()
  RETURNING status INTO claimed_status;

  IF claimed_status IS NOT NULL THEN
    -- A partial result remains retrievable but does not consume free allowance.
    IF claimed_status = 'succeeded' THEN
      UPDATE mobile_users
      SET successful_run_count = successful_run_count + 1
      WHERE id = claim_user_id;
    END IF;
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM mobile_runs
    WHERE id = claim_run_id
      AND user_id = claim_user_id
      AND claimed_at IS NOT NULL
      AND expires_at > now()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION claim_mobile_run(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_mobile_run(UUID, UUID) TO service_role;

-- Mobile clients authenticate with Supabase Auth but access these tables only through
-- the eVisaFlow API. No anon/authenticated policies are intentional; the service role
-- owns all database and private Storage operations.
