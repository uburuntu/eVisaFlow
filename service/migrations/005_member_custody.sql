-- 005_member_custody: per-member key custody for the E2EE web app.
--
-- ADDITIVE and IDEMPOTENT: every statement is guarded so re-running is a no-op
-- and existing bot rows are untouched. Existing rows default to `custody='server'`
-- and keep their AES-encrypted `encrypted_doc_number` (the trusted-bot path).
--
-- Two custody models share this table:
--   * server  — the trusted bot. Cleartext-ish columns stay populated:
--               `encrypted_doc_number` (AES, server key) plus the plaintext
--               `auth_type`/`dob_*`/`preferred_2fa_method`/`purpose`.
--   * client  — the web app (E2EE). The server stores ONLY `encrypted_secret`,
--               an opaque blob sealed to the user's public key holding the whole
--               applicant ({docType, docNumber, dob, 2fa, purpose}). No plaintext
--               doc/DOB/2fa is ever written for a client row, so those columns are
--               left NULL — which is why they must drop NOT NULL below.

-- ============================================================
-- FAMILY MEMBERS — add custody + sealed secret
-- ============================================================
ALTER TABLE family_members
  ADD COLUMN IF NOT EXISTS custody          TEXT NOT NULL DEFAULT 'server'
                           CHECK (custody IN ('server', 'client')),
  ADD COLUMN IF NOT EXISTS encrypted_secret BYTEA;

-- The cleartext-ish columns are mandatory only for server rows. Client rows keep
-- everything inside `encrypted_secret`, so these must accept NULL. DROP NOT NULL
-- is itself idempotent (a no-op once the column is already nullable). The
-- existing per-column CHECKs (`... IN (...)` / `... BETWEEN ...`) are NULL-safe,
-- so a NULL client value still satisfies them.
ALTER TABLE family_members ALTER COLUMN auth_type            DROP NOT NULL;
ALTER TABLE family_members ALTER COLUMN encrypted_doc_number DROP NOT NULL;
ALTER TABLE family_members ALTER COLUMN dob_day              DROP NOT NULL;
ALTER TABLE family_members ALTER COLUMN dob_month            DROP NOT NULL;
ALTER TABLE family_members ALTER COLUMN dob_year             DROP NOT NULL;
ALTER TABLE family_members ALTER COLUMN preferred_2fa_method DROP NOT NULL;
ALTER TABLE family_members ALTER COLUMN purpose              DROP NOT NULL;

-- Custody-shaped integrity: a server row must carry its AES doc number; a client
-- row must carry its sealed secret. Guarded so re-running does not error on the
-- already-present constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'family_members_custody_secret_check'
  ) THEN
    ALTER TABLE family_members
      ADD CONSTRAINT family_members_custody_secret_check
      CHECK (
        (custody = 'server' AND encrypted_doc_number IS NOT NULL)
        OR
        (custody = 'client' AND encrypted_secret IS NOT NULL)
      );
  END IF;
END;
$$;

-- The max-6-active trigger (`trg_max_family_members`) from 001 is intentionally
-- left untouched and continues to enforce the per-user active limit.
