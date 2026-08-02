ALTER TABLE mobile_runs
  ADD COLUMN claim_token_hash TEXT
    CHECK (claim_token_hash IS NULL OR claim_token_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN claim_manifest_hash TEXT
    CHECK (claim_manifest_hash IS NULL OR claim_manifest_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN claim_started_at TIMESTAMPTZ,
  ADD COLUMN claim_expires_at TIMESTAMPTZ;

CREATE INDEX idx_mobile_runs_claim_expiry
  ON mobile_runs(claim_expires_at)
  WHERE claimed_at IS NULL AND claim_expires_at IS NOT NULL;

CREATE OR REPLACE FUNCTION acknowledge_mobile_run(
  acknowledged_run_id UUID,
  acknowledged_user_id UUID,
  acknowledged_token_hash TEXT,
  acknowledged_manifest_hash TEXT
)
  RETURNS JSONB AS $$
DECLARE
  target mobile_runs%ROWTYPE;
  final_claimed_at TIMESTAMPTZ;
  consumes_usage BOOLEAN;
BEGIN
  SELECT * INTO target
  FROM mobile_runs
  WHERE id = acknowledged_run_id
    AND user_id = acknowledged_user_id
    AND status IN ('succeeded', 'partial_success')
    AND expires_at > now()
  FOR UPDATE;

  IF NOT FOUND
    OR target.claim_token_hash IS DISTINCT FROM acknowledged_token_hash
    OR target.claim_manifest_hash IS DISTINCT FROM acknowledged_manifest_hash
  THEN
    RETURN NULL;
  END IF;

  consumes_usage := target.status = 'succeeded';

  IF target.claimed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'claimedAt', target.claimed_at,
      'usageConsumed', consumes_usage
    );
  END IF;

  IF target.claim_expires_at IS NULL OR target.claim_expires_at <= now() THEN
    RETURN NULL;
  END IF;

  final_claimed_at := now();
  UPDATE mobile_runs
  SET claimed_at = final_claimed_at,
      encrypted_result = NULL
  WHERE id = acknowledged_run_id;

  IF consumes_usage THEN
    UPDATE mobile_users
    SET successful_run_count = successful_run_count + 1
    WHERE id = acknowledged_user_id;
  END IF;

  RETURN jsonb_build_object(
    'claimedAt', final_claimed_at,
    'usageConsumed', consumes_usage
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION acknowledge_mobile_run(UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION acknowledge_mobile_run(UUID, UUID, TEXT, TEXT)
  TO service_role;

-- The legacy one-step function increments usage before device persistence and must not
-- be used after this migration. It remains defined only so migration rollback does not
-- depend on recreating its body.
REVOKE EXECUTE ON FUNCTION claim_mobile_run(UUID, UUID) FROM service_role;
