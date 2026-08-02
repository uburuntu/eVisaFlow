import type {
  MobileArtifactDescriptor,
  MobileChallengeSubmission,
  MobileMe,
  MobileProfileSlotRequest,
  MobileRunClaimAcknowledgement,
  MobileRunClaimAcknowledgementRequest,
  MobileRunClaimSession,
  MobileRunCreateRequest,
  MobileRunEvent,
  MobileRunSnapshot,
} from "@evisa-flow/protocol";
import { mobileClaimManifestJson } from "@evisa-flow/protocol";
import { CryptoDigestAlgorithm, digest } from "expo-crypto";
import type { MobileApi } from "./client";
import { MobileApiRequestError } from "./client";

interface DemoRun {
  request: MobileRunCreateRequest;
  createdAt: string;
  challengeSubmittedAt?: number;
  cancelled: boolean;
  claimed: boolean;
  claimToken?: string;
  manifestHash?: string;
}

const artifactIds = {
  evisa_pdf: "8edecbaf-d7f9-4a93-a258-709501bdb501",
  checker_html: "8edecbaf-d7f9-4a93-a258-709501bdb502",
  checker_pdf: "8edecbaf-d7f9-4a93-a258-709501bdb503",
} as const;

export class DemoMobileApiClient implements MobileApi {
  private readonly slots = new Set<string>();
  private readonly runs = new Map<string, DemoRun>();
  private artifactsPromise: Promise<{
    descriptors: MobileArtifactDescriptor[];
    bytes: Map<string, Uint8Array>;
  }> | null = null;

  async getMe(): Promise<MobileMe> {
    const successfulRunCount = Array.from(this.runs.values()).filter(
      (run) => run.claimed
    ).length;
    return {
      userId: "6733d626-9f8d-4e1d-a7b5-76aa0ae96684",
      entitlement: "free",
      profileLimit: 1,
      activeProfileCount: this.slots.size,
      successfulRunCount,
      remainingFreeRuns: Math.max(0, 3 - successfulRunCount),
      serviceStatus: "available",
    };
  }

  async deleteAccount(): Promise<void> {
    this.slots.clear();
    this.runs.clear();
    this.artifactsPromise = null;
  }

  async putProfileSlot(slotId: string, request: MobileProfileSlotRequest): Promise<void> {
    if (slotId !== request.profileId) {
      throw apiError(400, "PROFILE_ID_MISMATCH", "Profile identifiers do not match.");
    }
    if (!this.slots.has(slotId) && this.slots.size >= 1) {
      throw apiError(402, "PROFILE_LIMIT", "The profile limit has been reached.");
    }
    this.slots.add(slotId);
  }

  async deleteProfileSlot(slotId: string): Promise<void> {
    this.slots.delete(slotId);
  }

  async createRun(request: MobileRunCreateRequest): Promise<MobileRunSnapshot> {
    if (!this.slots.has(request.profileId)) {
      throw apiError(404, "PROFILE_NOT_FOUND", "Profile slot not found.");
    }
    const existing = this.runs.get(request.clientRunId);
    if (existing) return this.snapshot(existing);
    const run: DemoRun = {
      request,
      createdAt: new Date().toISOString(),
      cancelled: false,
      claimed: false,
    };
    this.runs.set(request.clientRunId, run);
    return this.snapshot(run);
  }

  async getRun(runId: string): Promise<MobileRunSnapshot> {
    return this.snapshot(this.requireRun(runId));
  }

  async submitChallenge(
    runId: string,
    request: MobileChallengeSubmission
  ): Promise<MobileRunSnapshot> {
    const run = this.requireRun(runId);
    if (this.snapshot(run).status !== "awaiting_2fa") {
      throw apiError(409, "CHALLENGE_NOT_ACTIVE", "No security code is expected.");
    }
    if (request.code !== "123456") {
      throw apiError(
        400,
        "SECURITY_CODE_INVALID",
        "That security code was not accepted."
      );
    }
    run.challengeSubmittedAt = Date.now();
    return this.snapshot(run);
  }

  async cancelRun(runId: string): Promise<MobileRunSnapshot> {
    const run = this.requireRun(runId);
    run.cancelled = true;
    return this.snapshot(run);
  }

  async beginClaim(runId: string): Promise<MobileRunClaimSession> {
    const run = this.requireRun(runId);
    if (!isSuccessful(this.snapshot(run).status)) {
      throw apiError(409, "RESULT_NOT_READY", "The result is not ready to claim.", true);
    }
    const artifacts = (await this.artifacts()).descriptors;
    const generatedAt = new Date(
      (run.challengeSubmittedAt ?? new Date(run.createdAt).getTime()) + 1_300
    ).toISOString();
    const result = {
      shareCode: "ABC 123 XYZ",
      validUntil: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10),
      generatedAt,
      artifacts,
    };
    run.claimToken = "d".repeat(43);
    run.manifestHash = await sha256(mobileClaimManifestJson({ runId, ...result }));
    return {
      claimToken: run.claimToken,
      claimExpiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      manifestHash: run.manifestHash,
      ...result,
    };
  }

  async acknowledgeClaim(
    runId: string,
    request: MobileRunClaimAcknowledgementRequest
  ): Promise<MobileRunClaimAcknowledgement> {
    const run = this.requireRun(runId);
    if (
      !run.claimToken ||
      !run.manifestHash ||
      request.claimToken !== run.claimToken ||
      request.manifestHash !== run.manifestHash
    ) {
      throw apiError(
        409,
        "CLAIM_ACKNOWLEDGEMENT_REJECTED",
        "The secure result confirmation expired.",
        true
      );
    }
    run.claimed = true;
    return { claimedAt: new Date().toISOString(), usageConsumed: true };
  }

  async downloadArtifact(
    runId: string,
    artifact: MobileArtifactDescriptor,
    claimToken: string
  ): Promise<Uint8Array> {
    const run = this.requireRun(runId);
    if (!run.claimToken || claimToken !== run.claimToken) {
      throw apiError(404, "ARTIFACT_NOT_FOUND", "Artifact not found.");
    }
    const bytes = (await this.artifacts()).bytes.get(artifact.id);
    if (!bytes) throw apiError(404, "ARTIFACT_NOT_FOUND", "Artifact not found.");
    return bytes;
  }

  async streamRunEvents(
    runId: string,
    options: {
      lastEventId?: number;
      signal: AbortSignal;
      onEvent: (event: MobileRunEvent) => void;
    }
  ): Promise<void> {
    const run = this.requireRun(runId);
    let previous = "";
    let eventId = options.lastEventId ?? 0;
    while (!options.signal.aborted) {
      const snapshot = this.snapshot(run);
      const signature = `${snapshot.status}:${snapshot.phase ?? ""}`;
      if (signature !== previous) {
        previous = signature;
        eventId += 1;
        options.onEvent({
          id: eventId,
          runId,
          type: snapshot.status,
          ...(snapshot.phase ? { phase: snapshot.phase } : {}),
          createdAt: new Date().toISOString(),
        });
      }
      if (isTerminal(snapshot.status)) return;
      await delay(200);
    }
  }

  private requireRun(runId: string): DemoRun {
    const run = this.runs.get(runId);
    if (!run) throw apiError(404, "RUN_NOT_FOUND", "Run not found.");
    return run;
  }

  private snapshot(run: DemoRun): MobileRunSnapshot {
    const base = {
      id: run.request.clientRunId,
      clientRunId: run.request.clientRunId,
      profileId: run.request.profileId,
      purpose: run.request.purpose,
      createdAt: run.createdAt,
      updatedAt: new Date().toISOString(),
    };
    if (run.cancelled) {
      return { ...base, status: "cancelled", phase: "failed", retryable: false };
    }

    const elapsed = Date.now() - new Date(run.createdAt).getTime();
    if (!run.challengeSubmittedAt) {
      if (elapsed < 500) return { ...base, status: "queued", phase: "launching" };
      if (elapsed < 1_300) {
        return { ...base, status: "running", phase: "verifying_identity" };
      }
      return {
        ...base,
        status: "awaiting_2fa",
        phase: "waiting_for_2fa",
        challenge: {
          type: "security_code",
          deliveryMethod: run.request.preferredTwoFactorMethod,
          deadlineMs: Date.now() + 5 * 60 * 1000,
        },
      };
    }

    const afterChallenge = Date.now() - run.challengeSubmittedAt;
    if (afterChallenge < 650) {
      return { ...base, status: "running", phase: "creating_share_code" };
    }
    if (afterChallenge < 1_300) {
      return { ...base, status: "packaging", phase: "downloading_pdf" };
    }
    return { ...base, status: "succeeded", phase: "completed" };
  }

  private artifacts() {
    this.artifactsPromise ??= createDemoArtifacts();
    return this.artifactsPromise;
  }
}

async function createDemoArtifacts() {
  const values = [
    {
      id: artifactIds.evisa_pdf,
      kind: "evisa_pdf" as const,
      filename: "Fictional eVisa proof.pdf",
      contentType: "application/pdf" as const,
      bytes: createPdf("Fictional eVisa proof", "Share code: ABC 123 XYZ"),
    },
    {
      id: artifactIds.checker_html,
      kind: "checker_html" as const,
      filename: "Fictional status check.html",
      contentType: "text/html" as const,
      bytes: new TextEncoder().encode(
        "<!doctype html><html><body><h1>Fictional status check</h1><p>Demo data only.</p></body></html>"
      ),
    },
    {
      id: artifactIds.checker_pdf,
      kind: "checker_pdf" as const,
      filename: "Fictional status check.pdf",
      contentType: "application/pdf" as const,
      bytes: createPdf("Fictional status check", "Demo data only"),
    },
  ];
  const descriptors: MobileArtifactDescriptor[] = [];
  const bytes = new Map<string, Uint8Array>();
  for (const value of values) {
    const hashInput = new Uint8Array(new ArrayBuffer(value.bytes.byteLength));
    hashInput.set(value.bytes);
    descriptors.push({
      id: value.id,
      kind: value.kind,
      filename: value.filename,
      contentType: value.contentType,
      byteLength: value.bytes.byteLength,
      sha256: toHex(
        new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, hashInput))
      ),
    });
    bytes.set(value.id, value.bytes);
  }
  return { descriptors, bytes };
}

function createPdf(title: string, subtitle: string): Uint8Array {
  const stream = `BT /F1 22 Tf 72 720 Td (${escapePdf(title)}) Tj 0 -36 Td /F1 13 Tf (${escapePdf(subtitle)}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

async function sha256(value: string): Promise<string> {
  return toHex(
    new Uint8Array(
      await digest(CryptoDigestAlgorithm.SHA256, new TextEncoder().encode(value))
    )
  );
}

function isTerminal(status: MobileRunSnapshot["status"]): boolean {
  return [
    "succeeded",
    "partial_success",
    "failed",
    "cancelled",
    "interrupted",
    "expired",
  ].includes(status);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function escapePdf(value: string): string {
  return value.replace(/[\\()]/g, (character) => `\\${character}`);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function apiError(
  status: number,
  code: string,
  message: string,
  retryable = false
): MobileApiRequestError {
  return new MobileApiRequestError(status, { code, message, retryable });
}

function isSuccessful(status: MobileRunSnapshot["status"]): boolean {
  return status === "succeeded" || status === "partial_success";
}
