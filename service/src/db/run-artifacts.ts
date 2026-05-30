import { and, eq, lt } from "drizzle-orm";
import type { Db } from "./client.js";
import { runArtifacts } from "./schema.js";

/**
 * Drizzle accessors for the `run_artifacts` table (migration 006).
 *
 * Every `bytes` value here is ALREADY sealed before it reaches this layer:
 * AES-GCM for server custody (`sealed_alg='aesgcm'`) or anonymous
 * `crypto_box_seal` to the user's public key for client custody
 * (`sealed_alg='box_seal'`). These functions neither seal nor open — they only
 * persist and return opaque sealed bytes. No plaintext document/share-code bytes
 * are ever written through here.
 *
 * Self-host v1 keeps the sealed bytes inline in Postgres (`storage='db'`). A
 * later cloud build can offload to object storage (`storage='disk'`, via `path`)
 * behind the same accessors — the bytes are sealed either way.
 */

export interface DbRunArtifact {
  id: string;
  run_id: string | null;
  kind: string | null;
  filename: string | null;
  /** Algorithm the bytes were sealed with: 'aesgcm' (server) or 'box_seal' (client). */
  sealed_alg: string | null;
  storage: string;
  /** Sealed bytes when `storage='db'`; null when offloaded (`storage='disk'`). */
  bytes: Buffer | null;
  path: string | null;
  byte_length: number | null;
  expires_at: string;
  created_at: string;
}

type RunArtifactRow = typeof runArtifacts.$inferSelect;

function toDbRunArtifact(row: RunArtifactRow): DbRunArtifact {
  return {
    id: row.id,
    run_id: row.runId,
    kind: row.kind,
    filename: row.filename,
    sealed_alg: row.sealedAlg,
    storage: row.storage,
    bytes: row.bytes,
    path: row.path,
    byte_length: row.byteLength,
    expires_at: row.expiresAt,
    created_at: row.createdAt,
  };
}

/**
 * Inserts one sealed artifact row for a run. `bytes` MUST already be sealed by
 * the caller (the store/engine seals before reaching the DB). Stored inline in
 * the `bytea` column with `storage='db'` for self-host.
 */
export async function insertRunArtifact(
  db: Db,
  artifact: {
    run_id: string;
    kind: string;
    filename: string;
    sealed_alg: string;
    bytes: Buffer;
    byte_length: number;
    expires_at: string;
  }
): Promise<DbRunArtifact> {
  const [row] = await db
    .insert(runArtifacts)
    .values({
      runId: artifact.run_id,
      kind: artifact.kind,
      filename: artifact.filename,
      sealedAlg: artifact.sealed_alg,
      storage: "db",
      bytes: artifact.bytes,
      byteLength: artifact.byte_length,
      expiresAt: artifact.expires_at,
    })
    .returning();
  return toDbRunArtifact(row);
}

/** Lists every artifact for a run, oldest first (insertion order). */
export async function listRunArtifacts(db: Db, runId: string): Promise<DbRunArtifact[]> {
  const rows = await db
    .select()
    .from(runArtifacts)
    .where(eq(runArtifacts.runId, runId))
    .orderBy(runArtifacts.createdAt);
  return rows.map(toDbRunArtifact);
}

/**
 * Fetches a single artifact by id, scoped to its run so a caller cannot read an
 * artifact belonging to a different run. Returns null when absent.
 */
export async function getRunArtifact(
  db: Db,
  runId: string,
  artifactId: string
): Promise<DbRunArtifact | null> {
  const [row] = await db
    .select()
    .from(runArtifacts)
    .where(and(eq(runArtifacts.id, artifactId), eq(runArtifacts.runId, runId)))
    .limit(1);
  return row ? toDbRunArtifact(row) : null;
}

/**
 * Deletes every artifact whose `expires_at` is strictly before `now`. Returns
 * the number of rows removed (drives the cleanup cron's logging). `now` is an
 * ISO-8601 string to match the stored TIMESTAMPTZ representation.
 */
export async function deleteExpiredRunArtifacts(db: Db, now: string): Promise<number> {
  const deleted = await db
    .delete(runArtifacts)
    .where(lt(runArtifacts.expiresAt, now))
    .returning({ id: runArtifacts.id });
  return deleted.length;
}
