/**
 * Typed API surface for the app island.
 *
 * Thin, well-typed wrappers over the framework-agnostic {@link apiFetch} client
 * (`src/lib/api.ts`), one per route the island calls. Centralising them here
 * keeps the screens declarative (`getMe()`, `listMembers()`, …) and gives every
 * response a single shared type. Nothing here stores credentials or secrets —
 * auth is the HttpOnly session cookie, and the vault key material lives only in
 * the in-memory vault context, never in this module.
 *
 * All shapes mirror the server route handlers in `service/src/web/routes/*`. The
 * sealed/opaque blobs (`encryptedSecret`, vault blobs, sealed artifact bytes) are
 * decrypted exclusively in the browser via the vault helpers — the server never
 * sees plaintext.
 */
import { ApiError, apiFetch, apiUrl } from "../../lib/api.js";

export { ApiError };

/** Authenticated user profile — `GET /api/auth/me`. */
export interface Me {
  id: string;
  email: string | null;
  telegramLinked: boolean;
  hasVault: boolean;
}

/** Opaque vault blobs — `GET /api/vault`. base64 strings, decoded in-browser. */
export interface VaultResponse {
  publicKey: string;
  wrappedPrivateKey: string;
  kdfSalt: string;
  /** Argon2id params (+ embedded recovery salt/params); opaque to the server. */
  kdfParams: unknown;
  recoveryWrappedKey: string | null;
}

/** Body for `POST /api/vault`. Every field is an opaque base64 blob. */
export interface VaultUploadBody {
  publicKey: string;
  wrappedPrivateKey: string;
  kdfSalt: string;
  kdfParams: unknown;
  recoveryWrappedKey?: string;
}

/** A member as returned by `GET/POST /api/members`. */
export interface Member {
  id: string;
  displayName: string;
  custody: string;
  /** Sealed applicant blob (base64) for client custody; null for server rows. */
  encryptedSecret: string | null;
}

/** Body for `POST /api/members` (v1 web app is always client custody). */
export interface CreateMemberBody {
  displayName: string;
  custody: "client";
  encryptedSecret: string;
}

/** A run as returned by `GET /api/runs` (history). No secrets. */
export interface RunHistoryItem {
  id: string;
  familyMemberId: string;
  status: string;
  trigger: string;
  custody: string | null;
  validUntil: string | null;
  errorCode: string | null;
  createdAt: string;
}

/** Inline, browser-decrypted applicant sent per-run. Plaintext in transit only. */
export interface InlineApplicant {
  identityDocument: {
    type: "passport" | "nationalId" | "brc" | "ukvi";
    number: string;
  };
  dateOfBirth: { day: number; month: number; year: number };
}

/** Body for `POST /api/runs`. */
export interface CreateRunBody {
  memberId: string;
  applicant: InlineApplicant;
  purpose: "right_to_work" | "right_to_rent" | "immigration_status_other";
  twoFactorMethod?: "sms" | "email";
}

/** Metadata for a stored sealed artifact — `GET /api/runs/:id/artifacts`. */
export interface ArtifactListItem {
  id: string;
  kind: string | null;
  byteLength: number | null;
  sealedAlg: string | null;
  createdAt: string;
  expiresAt: string;
}

/** `GET /api/auth/me`. Returns null on 401 (not signed in) rather than throwing. */
export async function getMe(): Promise<Me | null> {
  try {
    return (await apiFetch<Me>("/auth/me")) ?? null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/** `POST /api/auth/logout`. Idempotent; clears the session cookie. */
export async function logout(): Promise<void> {
  await apiFetch("/auth/logout", { method: "POST" });
}

/** `GET /api/vault`. Returns null on 404 (no vault yet) rather than throwing. */
export async function getVault(): Promise<VaultResponse | null> {
  try {
    return (await apiFetch<VaultResponse>("/vault")) ?? null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** `POST /api/vault`. Stores the opaque blobs (create or rotate). */
export async function putVault(body: VaultUploadBody): Promise<void> {
  await apiFetch("/vault", { method: "POST", json: body });
}

/** `GET /api/members`. The caller's active members (with sealed secrets). */
export async function listMembers(): Promise<Member[]> {
  const data = await apiFetch<{ members: Member[] }>("/members");
  return data?.members ?? [];
}

/** `POST /api/members`. Stores a sealed member; returns the created row. */
export async function createMember(body: CreateMemberBody): Promise<Member> {
  const member = await apiFetch<Member>("/members", { method: "POST", json: body });
  if (!member) throw new Error("createMember: empty response");
  return member;
}

/** `DELETE /api/members/:id`. Soft-deletes one of the caller's members. */
export async function deleteMember(id: string): Promise<void> {
  await apiFetch(`/members/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** `POST /api/runs`. Enqueues a run from the inline applicant; returns its id. */
export async function createRun(body: CreateRunBody): Promise<string> {
  const data = await apiFetch<{ runId: string }>("/runs", { method: "POST", json: body });
  if (!data?.runId) throw new Error("createRun: missing runId");
  return data.runId;
}

/** `POST /api/runs/:id/code`. Delivers the 2FA code to the waiting run. */
export async function submitRunCode(runId: string, code: string): Promise<void> {
  await apiFetch(`/runs/${encodeURIComponent(runId)}/code`, {
    method: "POST",
    json: { code },
  });
}

/** `POST /api/runs/:id/cancel`. Cancels an in-flight run. */
export async function cancelRun(runId: string): Promise<void> {
  await apiFetch(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
}

/** `GET /api/runs`. Run history (newest first), no secrets. */
export async function listRuns(): Promise<RunHistoryItem[]> {
  const data = await apiFetch<{ runs: RunHistoryItem[] }>("/runs");
  return data?.runs ?? [];
}

/** `GET /api/runs/:id/artifacts`. Sealed-artifact metadata (no bytes). */
export async function listRunArtifacts(runId: string): Promise<ArtifactListItem[]> {
  const data = await apiFetch<{ artifacts: ArtifactListItem[] }>(
    `/runs/${encodeURIComponent(runId)}/artifacts`
  );
  return data?.artifacts ?? [];
}

/**
 * Fetches one artifact's OPAQUE sealed bytes (`application/octet-stream`). The
 * returned bytes are still sealed to the vault public key — the caller opens them
 * in-browser with {@link openSealedArtifact}. Uses a raw `fetch` (not the JSON
 * client) because the body is binary, and sends the session cookie same-origin.
 */
export async function fetchSealedArtifact(
  runId: string,
  artifactId: string
): Promise<Uint8Array> {
  const url = apiUrl(
    `/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`
  );
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) {
    throw new ApiError(res.status, undefined, "Failed to download sealed artifact");
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/** Builds the same-origin SSE URL for a run's event stream. */
export function runEventsUrl(runId: string): string {
  return apiUrl(`/runs/${encodeURIComponent(runId)}/events`);
}
