import { shareCodeExpiryDeadlineMs } from "@evisa-flow/protocol";

const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

export type ExpiryState = "valid" | "expiring_soon" | "expired" | "unknown";

export function getExpiryState(
  validUntil: string | undefined,
  nowMs = Date.now()
): ExpiryState {
  if (!validUntil) return "unknown";
  const expiryMs = shareCodeExpiryDeadlineMs(validUntil);
  if (!Number.isFinite(expiryMs)) return "unknown";
  if (expiryMs <= nowMs) return "expired";
  if (expiryMs - nowMs <= EXPIRING_SOON_MS) return "expiring_soon";
  return "valid";
}
