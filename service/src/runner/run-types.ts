import type { Applicant, DiagnosticsMode, Purpose, TwoFactorMethod } from "evisa-flow";

/**
 * Shared channel-agnostic run types.
 *
 * These live in their own module so the run engine, the run bus, and the secret
 * resolver can all depend on them without importing each other — keeping the
 * dependency graph acyclic (`run-engine` → `run-bus`/`secret-resolver` →
 * `run-types`, never back the other way).
 */

/** Who holds the key material that protects a member's secrets. */
export type RunCustody = "client" | "server";

/**
 * Per-run applicant input.
 *
 * - `inline`: client-custody. The browser-ready plaintext applicant is supplied
 *   directly (decrypted in the user's browser, sent over TLS per run). It is
 *   never persisted, never logged.
 * - `memberRef`: server-custody. The applicant is materialized server-side by
 *   decrypting the stored, AES-encrypted member record.
 */
export type RunApplicantInput =
  | {
      kind: "inline";
      applicant: Applicant;
      purpose: Purpose;
      twoFactorMethod?: TwoFactorMethod;
      memberName: string;
    }
  | { kind: "memberRef"; userId: string; familyMemberId: string };

export interface EnqueueRunInput {
  runId: string;
  ownerKey: string;
  custody: RunCustody;
  /** Required for client custody: outputs are sealed to this X25519 public key. */
  recipientPublicKey?: Uint8Array;
  applicant: RunApplicantInput;
  trigger: "manual" | "scheduled";
  headless: boolean;
  diagnosticsMode: DiagnosticsMode;
}

export type EnqueueResult =
  | { accepted: true; runId: string; position: number }
  | { accepted: false; runId: string; position: number; reason: string };

/** Opaque sealed bytes plus the algorithm that produced them. */
export interface SealedBlob {
  /** `aesgcm` for server custody, `box_seal` for client custody. */
  alg: "aesgcm" | "box_seal";
  /**
   * For `box_seal`: raw sealed bytes. For `aesgcm`: the encrypted string is
   * surfaced via {@link SealedBlob.cipher}; `bytes` is left undefined.
   */
  bytes?: Uint8Array;
  /** AES-GCM ciphertext string (server custody) when not byte-oriented. */
  cipher?: string;
}

/** A produced artifact, sealed for the recipient before it leaves the worker. */
export interface SealedArtifactRef {
  kind: "pdf" | "checker_html" | "checker_pdf";
  filename: string;
  contentType: string;
  byteLength: number;
  sealed: SealedBlob;
}

/**
 * The channel-agnostic event union the engine publishes. The engine is the
 * single place that translates the core lib's `EVisaEvent` into these.
 *
 * Server-custody runs (the trusted bot) may carry unsealed share codes/bytes;
 * client-custody runs always carry sealed forms only.
 */
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
      /** Present only for trusted server-custody runs. */
      shareCode?: string;
    }
  | { type: "failed"; code: string; message: string; terminal: boolean };

export type RunStatus = "queued" | "running" | "awaiting_2fa" | "completed" | "failed";

/** Latest derived state for a run, replayable to late subscribers. */
export interface RunSnapshot {
  runId: string;
  status: RunStatus;
  position?: number;
  active?: number;
  phase?: string;
  phaseLabel?: string;
  challengeMethod?: TwoFactorMethod;
  challengeDeadlineMs?: number;
  validUntil?: string;
  errorCode?: string;
  errorMessage?: string;
  lastEvent?: RunEvent;
}
