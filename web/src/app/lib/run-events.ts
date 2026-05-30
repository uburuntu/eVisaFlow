/**
 * Client-side mirror of the server's run-event union and the helpers needed to
 * consume it over SSE.
 *
 * The event shapes here match `service/src/runner/run-types.ts` (`RunEvent`). One
 * subtlety drives the decoder below: the server serialises events with
 * `JSON.stringify`, which turns a `Uint8Array` into a plain object of numeric,
 * stringified indices (`{"0":12,"1":255,…}`) — NOT a JSON array. The only
 * byte-bearing field that reaches the browser this way is the `completed` event's
 * `sealedShareCode.bytes` (client custody, `box_seal`); artifacts are fetched as
 * binary via their endpoint instead. {@link decodeJsonBytes} reconstructs the
 * `Uint8Array` from whatever JSON form arrived, so the share code can be opened
 * with the vault key.
 */

/** Two-factor delivery channel, as the core lib reports it. */
export type TwoFactorMethod = "sms" | "email";

/** Opaque sealed bytes plus the algorithm that produced them. */
export interface SealedBlob {
  alg: "aesgcm" | "box_seal";
  /** `box_seal` only. Arrives JSON-serialised; decode with {@link decodeJsonBytes}. */
  bytes?: unknown;
  /** `aesgcm` only (server custody); never present for the web app. */
  cipher?: string;
}

/** A produced artifact, sealed before it left the worker. */
export interface SealedArtifactRef {
  kind: "pdf" | "checker_html" | "checker_pdf";
  filename: string;
  contentType: string;
  byteLength: number;
  sealed: SealedBlob;
}

/** The event union the SSE stream delivers (see server `RunEvent`). */
export type RunEvent =
  | { type: "queued"; position: number; active: number }
  | { type: "started" }
  | { type: "phase"; phase: string; label: string }
  | {
      type: "timing";
      phase: string;
      operation: string;
      durationMs: number;
      stepId?: string;
    }
  | { type: "challenge_required"; method: TwoFactorMethod; deadlineMs: number }
  | { type: "artifact_ready"; artifact: SealedArtifactRef }
  | {
      type: "completed";
      validUntil?: string;
      sealedShareCode: SealedBlob;
      shareCode?: string;
    }
  | {
      type: "failed";
      code: string;
      message: string;
      terminal: boolean;
      cause?: "cancelled" | "interrupted";
    };

/** Event types after which the stream ends — used to stop the EventSource. */
export const TERMINAL_EVENT_TYPES = new Set<RunEvent["type"]>(["completed", "failed"]);

/**
 * Reconstructs a `Uint8Array` from a value that crossed a `JSON.stringify`
 * boundary. Handles the three forms a byte buffer can take after round-tripping
 * through JSON:
 *
 *   - a real `Uint8Array` (defensive — e.g. unit tests passing bytes directly),
 *   - a JSON array of numbers (`[12, 255, …]`),
 *   - a plain object of index→byte (`{"0":12,"1":255,…}`) — what
 *     `JSON.stringify(new Uint8Array(...))` actually emits.
 *
 * Returns undefined for null/undefined input (e.g. a `completed` with no share
 * code). Object keys are sorted numerically so the byte order is preserved
 * regardless of enumeration order.
 */
export function decodeJsonBytes(value: unknown): Uint8Array | undefined {
  if (value == null) return undefined;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, number>);
    const out = new Uint8Array(entries.length);
    for (const [key, byte] of entries) {
      const idx = Number(key);
      if (Number.isInteger(idx) && idx >= 0 && idx < out.length) {
        out[idx] = byte;
      }
    }
    return out;
  }
  return undefined;
}

/**
 * Extracts the sealed share-code bytes from a `completed` event, if any. Returns
 * undefined when the run produced no share code (the server sends a `completed`
 * with an empty/absent sealed payload) or when the blob is not a `box_seal` (the
 * web app is always client custody, so this should always be `box_seal`).
 */
export function sealedShareCodeBytes(
  event: Extract<RunEvent, { type: "completed" }>
): Uint8Array | undefined {
  const blob = event.sealedShareCode;
  if (!blob || blob.alg !== "box_seal") return undefined;
  return decodeJsonBytes(blob.bytes);
}
