import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../migrations/005_two_phase_mobile_claim.sql",
  import.meta.url
);

test("two-phase claim migration accounts for usage only after a locked acknowledgement", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const lockPosition = sql.indexOf("FOR UPDATE");
  const expiryPosition = sql.indexOf("target.claim_expires_at <= now()");
  const claimPosition = sql.indexOf("SET claimed_at = final_claimed_at");
  const usagePosition = sql.indexOf("successful_run_count = successful_run_count + 1");

  assert.match(
    sql,
    /WHERE id = acknowledged_run_id\s+AND user_id = acknowledged_user_id/
  );
  assert.match(sql, /claim_token_hash IS DISTINCT FROM acknowledged_token_hash/);
  assert.match(sql, /claim_manifest_hash IS DISTINCT FROM acknowledged_manifest_hash/);
  assert.match(sql, /IF target\.claimed_at IS NOT NULL THEN/);
  assert.match(sql, /SET claimed_at = final_claimed_at,\s+encrypted_result = NULL/);
  assert.ok(lockPosition > 0, "the owned run must be row-locked");
  assert.ok(expiryPosition > lockPosition, "claim expiry must be checked under the lock");
  assert.ok(claimPosition > expiryPosition, "claiming must follow the expiry check");
  assert.ok(usagePosition > claimPosition, "usage must follow the durable claim update");
  assert.match(
    sql,
    /REVOKE EXECUTE ON FUNCTION claim_mobile_run\(UUID, UUID\) FROM service_role/
  );
});
