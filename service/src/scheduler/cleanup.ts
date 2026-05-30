import cron, { type ScheduledTask } from "node-cron";
import {
  deleteConsumedOrExpiredMagicLinkTokens,
  deleteExpiredSessions,
} from "../db/cleanup.js";
import type { Db } from "../db/client.js";
import type { Env } from "../env.js";
import type { ArtifactStore } from "../runner/artifact-store.js";
import type { Logger } from "../utils/logger.js";

/** Counts removed by one cleanup sweep, per resource. */
export interface CleanupResult {
  artifacts: number;
  sessions: number;
  magicLinkTokens: number;
}

/**
 * Runs one cleanup sweep: deletes expired sealed run artifacts (via the
 * {@link ArtifactStore}), expired sessions, and consumed-or-expired magic-link
 * tokens. Each step is independent and best-effort — a failure in one is logged
 * and does not prevent the others, so a single bad table never blocks the rest of
 * the housekeeping. Returns the per-resource counts (0 for any failed step).
 *
 * None of these rows hold plaintext secrets (artifacts are sealed; sessions and
 * tokens store only hashes), so deletion is pure housekeeping.
 */
export async function runCleanup(
  db: Db,
  artifactStore: ArtifactStore,
  log: Logger
): Promise<CleanupResult> {
  const now = new Date();
  const nowIso = now.toISOString();

  const result: CleanupResult = { artifacts: 0, sessions: 0, magicLinkTokens: 0 };

  try {
    result.artifacts = await artifactStore.deleteExpired(now);
  } catch (err) {
    log.warn({ err }, "Cleanup: failed to delete expired run artifacts");
  }

  try {
    result.sessions = await deleteExpiredSessions(db, nowIso);
  } catch (err) {
    log.warn({ err }, "Cleanup: failed to delete expired sessions");
  }

  try {
    result.magicLinkTokens = await deleteConsumedOrExpiredMagicLinkTokens(db, nowIso);
  } catch (err) {
    log.warn({ err }, "Cleanup: failed to delete consumed/expired magic-link tokens");
  }

  return result;
}

/**
 * Schedules {@link runCleanup} on `env.CLEANUP_CRON` (hourly by default). The
 * sweep is wrapped so a thrown error is logged and never escapes the cron tick.
 * Returns the {@link ScheduledTask} so the caller can `.stop()` it on shutdown.
 */
export function startCleanupScheduler(
  db: Db,
  artifactStore: ArtifactStore,
  env: Env,
  log: Logger
): ScheduledTask {
  log.info({ cron: env.CLEANUP_CRON }, "Starting cleanup scheduler");

  return cron.schedule(env.CLEANUP_CRON, async () => {
    log.info("Cleanup tick: sweeping expired artifacts, sessions, and tokens");
    try {
      const removed = await runCleanup(db, artifactStore, log);
      if (removed.artifacts || removed.sessions || removed.magicLinkTokens) {
        log.info({ removed }, "Cleanup sweep removed expired rows");
      }
    } catch (err) {
      log.error({ err }, "Cleanup scheduler error");
    }
  });
}
