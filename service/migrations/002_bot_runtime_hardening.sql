ALTER TABLE runs
  DROP CONSTRAINT IF EXISTS runs_status_check;

ALTER TABLE runs
  ADD CONSTRAINT runs_status_check
  CHECK (status IN (
    'pending',
    'running',
    'awaiting_2fa',
    'success',
    'failed',
    'cancelled',
    'interrupted'
  ));

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS encrypted_share_code TEXT,
  ADD COLUMN IF NOT EXISTS error_code TEXT;

UPDATE runs
SET
  status = 'interrupted',
  error_code = COALESCE(error_code, 'MIGRATION_INTERRUPTED'),
  error_message = COALESCE(error_message, 'Interrupted by runtime hardening migration'),
  completed_at = COALESCE(completed_at, now())
WHERE status IN ('pending', 'running', 'awaiting_2fa');

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_active_per_member
  ON runs(user_id, family_member_id)
  WHERE status IN ('pending', 'running', 'awaiting_2fa');

CREATE TABLE IF NOT EXISTS run_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  phase       TEXT,
  page_kind   TEXT,
  operation   TEXT,
  duration_ms DOUBLE PRECISION,
  step_id     TEXT,
  error_code  TEXT,
  message     TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_created
  ON run_events(run_id, created_at);

ALTER TABLE run_events ENABLE ROW LEVEL SECURITY;
