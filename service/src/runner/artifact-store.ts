import type { Db } from "../db/client.js";
import {
  deleteExpiredRunArtifacts,
  getRunArtifact,
  insertRunArtifact,
  listRunArtifacts,
} from "../db/run-artifacts.js";
import type { SealedArtifactRef } from "./run-types.js";

/**
 * Persistence for a run's sealed output artifacts (eVisa PDF, checker HTML/PDF).
 *
 * INVARIANT: bytes are ALREADY sealed before they reach this store — AES-GCM for
 * server custody or anonymous `crypto_box_seal` to the user's public key for
 * client custody. The store never seals, never opens, and never sees plaintext;
 * it only moves opaque sealed bytes in and out. For client-custody runs this is
 * what keeps the E2EE boundary intact: only sealed forms are ever persisted.
 *
 * A future R2/object-storage-backed store for cloud implements this same
 * interface (sealed bytes go to R2 with `storage='disk'`/a `path`, metadata
 * stays in Postgres); callers and the engine do not change.
 */
export interface ArtifactStore {
  /** Persists one already-sealed artifact for a run; returns its row id. */
  putSealed(runId: string, ref: SealedArtifactRef): Promise<{ id: string }>;
  /** Fetches one stored artifact (sealed bytes + metadata), scoped to its run. */
  getSealed(runId: string, artifactId: string): Promise<StoredArtifact | null>;
  /** Lists a run's stored artifacts (metadata + sealed bytes), oldest first. */
  listForRun(runId: string): Promise<StoredArtifact[]>;
  /** Deletes artifacts whose TTL has elapsed; returns the count removed. */
  deleteExpired(now: Date): Promise<number>;
}

/** A stored artifact as read back from the store: metadata plus sealed bytes. */
export interface StoredArtifact {
  id: string;
  runId: string | null;
  kind: string | null;
  filename: string | null;
  /** Algorithm the bytes were sealed with: 'aesgcm' (server) or 'box_seal' (client). */
  sealedAlg: string | null;
  byteLength: number | null;
  /** Opaque sealed bytes (still sealed — the store never opens them). */
  bytes: Buffer | null;
  expiresAt: string;
  createdAt: string;
}

/**
 * Maps the engine's {@link SealedArtifactRef} kind to the `run_artifacts.kind`
 * CHECK domain (migration 006). The engine names the eVisa document `pdf`; the
 * table records it as `evisa_pdf`. Checker artifacts share the same names.
 */
const KIND_TO_DB: Record<SealedArtifactRef["kind"], string> = {
  pdf: "evisa_pdf",
  checker_html: "checker_html",
  checker_pdf: "checker_pdf",
};

/**
 * Postgres-backed {@link ArtifactStore} for self-host: sealed bytes live inline
 * in the `run_artifacts.bytes` `bytea` column (`storage='db'`). Backed entirely
 * by `db/run-artifacts.ts`.
 *
 * @param ttlMs how long a stored artifact lives before {@link ArtifactStore.deleteExpired}
 *   may remove it. Applied at write time as `expires_at = now + ttlMs`.
 */
export function createPostgresArtifactStore(
  db: Db,
  options: { ttlMs: number }
): ArtifactStore {
  const { ttlMs } = options;

  return {
    async putSealed(runId, ref) {
      // The sealed blob must be byte-oriented to land in the bytea column. Both
      // custody providers surface artifact bytes this way (server: raw bytes
      // tagged 'aesgcm'; client: 'box_seal' bytes); a `cipher`-only blob would
      // be a share code, not an artifact.
      const sealedBytes = ref.sealed.bytes;
      if (!sealedBytes) {
        throw new Error("ArtifactStore.putSealed: sealed artifact has no bytes to store");
      }
      const row = await insertRunArtifact(db, {
        run_id: runId,
        kind: KIND_TO_DB[ref.kind],
        filename: ref.filename,
        sealed_alg: ref.sealed.alg,
        bytes: Buffer.from(sealedBytes),
        byte_length: ref.byteLength,
        expires_at: new Date(Date.now() + ttlMs).toISOString(),
      });
      return { id: row.id };
    },

    async getSealed(runId, artifactId) {
      const row = await getRunArtifact(db, runId, artifactId);
      return row ? toStoredArtifact(row) : null;
    },

    async listForRun(runId) {
      const rows = await listRunArtifacts(db, runId);
      return rows.map(toStoredArtifact);
    },

    async deleteExpired(now) {
      return deleteExpiredRunArtifacts(db, now.toISOString());
    },
  };
}

function toStoredArtifact(row: {
  id: string;
  run_id: string | null;
  kind: string | null;
  filename: string | null;
  sealed_alg: string | null;
  byte_length: number | null;
  bytes: Buffer | null;
  expires_at: string;
  created_at: string;
}): StoredArtifact {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    filename: row.filename,
    sealedAlg: row.sealed_alg,
    byteLength: row.byte_length,
    bytes: row.bytes,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}
