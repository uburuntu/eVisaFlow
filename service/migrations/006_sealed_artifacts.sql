-- 006_sealed_artifacts: custody-aware share-code tagging on runs, plus a
-- `run_artifacts` table holding sealed output bytes (eVisa PDF, checker HTML/PDF).
--
-- ADDITIVE and IDEMPOTENT: every statement is guarded so re-running is a no-op
-- and existing rows are untouched.
--
-- The bytes in `run_artifacts` are ALWAYS stored in sealed form:
--   * server custody (trusted bot) — AES-GCM with the server key (`sealed_alg='aesgcm'`).
--   * client custody (web, E2EE)   — anonymous `crypto_box_seal` to the user's
--                                     public key (`sealed_alg='box_seal'`); the
--                                     server holds no private key to open them.
-- No plaintext document/share-code bytes are ever written here. Self-host v1
-- keeps bytes inline in Postgres (`storage='db'`); a later cloud build can set
-- `storage='disk'` and use `path` via an ArtifactStore — bytes are sealed either way.

-- ============================================================
-- RUNS — record the share-code algorithm + denormalized custody
-- ============================================================
-- Inline CHECK rides along with the column add, which `ADD COLUMN IF NOT EXISTS`
-- makes idempotent (the whole clause is skipped once the column exists).
ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS share_code_alg TEXT
                           CHECK (share_code_alg IN ('aesgcm', 'box_seal')),
  ADD COLUMN IF NOT EXISTS custody        TEXT;

-- ============================================================
-- RUN ARTIFACTS — sealed output blobs with TTL
-- ============================================================
CREATE TABLE IF NOT EXISTS run_artifacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID REFERENCES runs(id) ON DELETE CASCADE,
  kind        TEXT CHECK (kind IN ('evisa_pdf', 'checker_html', 'checker_pdf')),
  filename    TEXT,
  sealed_alg  TEXT,
  storage     TEXT NOT NULL DEFAULT 'db' CHECK (storage IN ('db', 'disk')),
  bytes       BYTEA,
  path        TEXT,
  byte_length INT,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_run_artifacts_run ON run_artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_run_artifacts_expires ON run_artifacts(expires_at);

ALTER TABLE run_artifacts ENABLE ROW LEVEL SECURITY;
