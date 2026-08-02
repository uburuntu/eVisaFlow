import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  MobileArtifactDescriptor,
  MobileMe,
  MobileRunClaimAcknowledgement,
  MobileRunClaimAcknowledgementRequest,
  MobileRunClaimSession,
  MobileRunCreateRequest,
  MobileRunEvent,
  MobileRunSnapshot,
} from "evisa-flow/protocol";
import {
  MobileRunClaimAcknowledgementSchema,
  MobileRunClaimSessionSchema,
  MobileRunCreateRequestSchema,
  mobileClaimManifestJson,
} from "evisa-flow/protocol";
import { decrypt, decryptBytes, encrypt, encryptBytes } from "../crypto/encryption.js";

const ARTIFACT_BUCKET = "mobile-run-artifacts";
const FREE_PROFILE_LIMIT = 1;
const PRO_PROFILE_LIMIT = 6;
const FREE_RESULT_LIMIT = 3;
const CLAIM_TTL_MS = 10 * 60 * 1000;

interface DbMobileUser {
  id: string;
  entitlement: "free" | "evisaflow_pro";
  successful_run_count: number;
}

interface DbMobileRun {
  id: string;
  user_id: string;
  profile_id: string;
  purpose: MobileRunCreateRequest["purpose"];
  status: MobileRunSnapshot["status"];
  phase: MobileRunSnapshot["phase"] | null;
  encrypted_request: string | null;
  encrypted_result: string | null;
  challenge_method: "sms" | "email" | null;
  challenge_deadline: string | null;
  retryable: boolean | null;
  error_code: string | null;
  completed_at: string | null;
  claimed_at: string | null;
  claim_token_hash: string | null;
  claim_manifest_hash: string | null;
  claim_expires_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

interface DbMobileArtifact {
  id: string;
  run_id: string;
  kind: MobileArtifactDescriptor["kind"];
  storage_path: string;
  filename: string;
  content_type: MobileArtifactDescriptor["contentType"];
  byte_length: number;
  sha256: string;
  expires_at: string;
}

interface StoredResult {
  shareCode: string;
  validUntil?: string;
}

export class MobileStore {
  constructor(
    private readonly db: SupabaseClient,
    private readonly encryptionKey: string,
    private readonly maxDailyRuns = 25
  ) {}

  async getMe(userId: string): Promise<MobileMe> {
    const user = await this.ensureUser(userId);
    const [
      { count: profileCount, error: profileCountError },
      { count: pendingSuccessCount, error: pendingSuccessError },
      { data: flag, error: flagError },
    ] = await Promise.all([
      this.db
        .from("mobile_profile_slots")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("is_active", true),
      this.db
        .from("mobile_runs")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "succeeded")
        .is("claimed_at", null),
      this.db
        .from("mobile_service_flags")
        .select("status,public_message")
        .eq("id", true)
        .single(),
    ]);
    if (profileCountError) throw profileCountError;
    if (pendingSuccessError) throw pendingSuccessError;
    if (flagError) throw flagError;

    const isPro = user.entitlement === "evisaflow_pro";
    const reservedSuccessCount = user.successful_run_count + (pendingSuccessCount ?? 0);
    return {
      userId,
      entitlement: user.entitlement,
      profileLimit: isPro ? PRO_PROFILE_LIMIT : FREE_PROFILE_LIMIT,
      activeProfileCount: profileCount ?? 0,
      successfulRunCount: user.successful_run_count,
      remainingFreeRuns: isPro
        ? null
        : Math.max(0, FREE_RESULT_LIMIT - reservedSuccessCount),
      serviceStatus: flag.status,
      ...(flag.public_message ? { serviceMessage: flag.public_message } : {}),
    };
  }

  async upsertProfileSlot(userId: string, profileId: string): Promise<void> {
    await this.ensureUser(userId);
    const { error } = await this.db
      .from("mobile_profile_slots")
      .upsert(
        { id: profileId, user_id: userId, is_active: true },
        { onConflict: "user_id,id" }
      );
    if (error) throw error;
  }

  async getActiveRunIds(userId: string): Promise<string[]> {
    const { data, error } = await this.db
      .from("mobile_runs")
      .select("id")
      .eq("user_id", userId)
      .in("status", ["queued", "running", "awaiting_2fa", "packaging"]);
    if (error) throw error;
    return (data ?? []).map((run) => String(run.id));
  }

  async deleteAccount(userId: string): Promise<void> {
    const { data: artifacts, error: artifactError } = await this.db
      .from("mobile_run_artifacts")
      .select("storage_path,mobile_runs!inner(user_id)")
      .eq("mobile_runs.user_id", userId);
    if (artifactError) throw artifactError;

    const storagePaths = (artifacts ?? []).map((artifact) => artifact.storage_path);
    if (storagePaths.length > 0) {
      const { error: storageError } = await this.db.storage
        .from(ARTIFACT_BUCKET)
        .remove(storagePaths);
      if (storageError) throw storageError;
    }

    const { error: deleteError } = await this.db.auth.admin.deleteUser(userId);
    if (deleteError) throw deleteError;
  }

  async cleanupExpiredData(now = new Date()): Promise<{
    artifactsDeleted: number;
    eventsDeleted: number;
  }> {
    const nowIso = now.toISOString();
    const { data: artifacts, error: artifactError } = await this.db
      .from("mobile_run_artifacts")
      .select("id,storage_path")
      .lt("expires_at", nowIso)
      .limit(500);
    if (artifactError) throw artifactError;

    const artifactRows = artifacts ?? [];
    if (artifactRows.length > 0) {
      const { error: storageError } = await this.db.storage
        .from(ARTIFACT_BUCKET)
        .remove(artifactRows.map((artifact) => artifact.storage_path));
      if (storageError) throw storageError;
      const { error: deleteError } = await this.db
        .from("mobile_run_artifacts")
        .delete()
        .in(
          "id",
          artifactRows.map((artifact) => artifact.id)
        );
      if (deleteError) throw deleteError;
    }

    const { error: runError } = await this.db
      .from("mobile_runs")
      .update({
        status: "expired",
        phase: "failed",
        encrypted_request: null,
        encrypted_result: null,
        claim_token_hash: null,
        claim_manifest_hash: null,
        claim_started_at: null,
        claim_expires_at: null,
        challenge_method: null,
        challenge_deadline: null,
        retryable: false,
      })
      .lt("expires_at", nowIso)
      .neq("status", "expired");
    if (runError) throw runError;

    const eventCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { count: eventsDeleted, error: eventError } = await this.db
      .from("mobile_run_events")
      .delete({ count: "exact" })
      .lt("created_at", eventCutoff);
    if (eventError) throw eventError;
    return {
      artifactsDeleted: artifactRows.length,
      eventsDeleted: eventsDeleted ?? 0,
    };
  }

  async deleteProfileSlot(userId: string, profileId: string): Promise<void> {
    const { error } = await this.db
      .from("mobile_profile_slots")
      .update({ is_active: false })
      .eq("id", profileId)
      .eq("user_id", userId);
    if (error) throw error;
  }

  async createRun(
    userId: string,
    request: MobileRunCreateRequest
  ): Promise<MobileRunSnapshot> {
    await this.ensureUserCanRun(userId, request.profileId);
    const now = new Date().toISOString();
    const { data, error } = await this.db
      .from("mobile_runs")
      .insert({
        id: request.clientRunId,
        user_id: userId,
        profile_id: request.profileId,
        purpose: request.purpose,
        status: "queued",
        encrypted_request: encrypt(JSON.stringify(request), this.encryptionKey),
        started_at: now,
      })
      .select()
      .single();
    if (error) throw error;
    await this.appendEvent(request.clientRunId, "queued", "launching");
    return this.toSnapshot(data as DbMobileRun, []);
  }

  async getRun(userId: string, runId: string): Promise<MobileRunSnapshot | null> {
    const { data, error } = await this.db
      .from("mobile_runs")
      .select()
      .eq("id", runId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return this.toSnapshot(data as DbMobileRun, await this.getArtifacts(runId));
  }

  async getRunRequest(runId: string): Promise<MobileRunCreateRequest> {
    const { data, error } = await this.db
      .from("mobile_runs")
      .select("encrypted_request")
      .eq("id", runId)
      .single();
    if (error) throw error;
    if (!data.encrypted_request) throw new Error("Run request has already been deleted");
    return MobileRunCreateRequestSchema.parse(
      JSON.parse(decrypt(data.encrypted_request, this.encryptionKey))
    );
  }

  async updateRun(
    runId: string,
    update: {
      status?: MobileRunSnapshot["status"];
      phase?: MobileRunSnapshot["phase"];
      challengeMethod?: "sms" | "email" | null;
      challengeDeadline?: string | null;
      retryable?: boolean;
      errorCode?: string;
      clearRequest?: boolean;
    }
  ): Promise<void> {
    const payload: Record<string, unknown> = {};
    if (update.status !== undefined) payload.status = update.status;
    if (update.phase !== undefined) payload.phase = update.phase;
    if (update.challengeMethod !== undefined)
      payload.challenge_method = update.challengeMethod;
    if (update.challengeDeadline !== undefined)
      payload.challenge_deadline = update.challengeDeadline;
    if (update.retryable !== undefined) payload.retryable = update.retryable;
    if (update.errorCode !== undefined) payload.error_code = update.errorCode;
    if (update.clearRequest) payload.encrypted_request = null;
    if (
      update.status &&
      ["succeeded", "partial_success", "failed", "cancelled", "interrupted"].includes(
        update.status
      )
    ) {
      payload.completed_at = new Date().toISOString();
    }
    const { error } = await this.db.from("mobile_runs").update(payload).eq("id", runId);
    if (error) throw error;
  }

  async appendEvent(
    runId: string,
    eventType: string,
    phase?: MobileRunSnapshot["phase"],
    message?: string
  ): Promise<void> {
    const { error } = await this.db.from("mobile_run_events").insert({
      run_id: runId,
      event_type: eventType,
      phase,
      message,
    });
    if (error) throw error;
  }

  async getEvents(
    userId: string,
    runId: string,
    afterId: number
  ): Promise<MobileRunEvent[]> {
    const { data, error } = await this.db
      .from("mobile_run_events")
      .select("id,event_type,phase,message,created_at,mobile_runs!inner(user_id)")
      .eq("run_id", runId)
      .eq("mobile_runs.user_id", userId)
      .gt("id", afterId)
      .order("id", { ascending: true })
      .limit(100);
    if (error) throw error;
    return (data ?? []).map((event) => ({
      id: Number(event.id),
      runId,
      type: event.event_type,
      ...(event.phase ? { phase: event.phase } : {}),
      ...(event.message ? { message: event.message } : {}),
      createdAt: event.created_at,
    }));
  }

  async saveResult(
    runId: string,
    result: StoredResult,
    artifacts: Array<{
      kind: MobileArtifactDescriptor["kind"];
      filename: string;
      contentType: MobileArtifactDescriptor["contentType"];
      bytes: Uint8Array;
    }>
  ): Promise<MobileArtifactDescriptor[]> {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const descriptors: MobileArtifactDescriptor[] = [];
    const uploadedPaths: string[] = [];

    try {
      for (const artifact of artifacts) {
        const id = randomUUID();
        const storagePath = `${runId}/${id}.enc`;
        const encrypted = encryptBytes(artifact.bytes, this.encryptionKey);
        const sha256 = createHash("sha256").update(artifact.bytes).digest("hex");
        const { error: uploadError } = await this.db.storage
          .from(ARTIFACT_BUCKET)
          .upload(storagePath, encrypted, {
            contentType: "application/octet-stream",
            upsert: false,
          });
        if (uploadError) throw uploadError;
        uploadedPaths.push(storagePath);

        const descriptor: MobileArtifactDescriptor = {
          id,
          kind: artifact.kind,
          filename: artifact.filename,
          contentType: artifact.contentType,
          byteLength: artifact.bytes.byteLength,
          sha256,
        };
        const { error: insertError } = await this.db.from("mobile_run_artifacts").insert({
          id,
          run_id: runId,
          kind: artifact.kind,
          storage_path: storagePath,
          filename: artifact.filename,
          content_type: artifact.contentType,
          byte_length: artifact.bytes.byteLength,
          sha256,
          expires_at: expiresAt,
        });
        if (insertError) throw insertError;
        descriptors.push(descriptor);
      }

      const { error } = await this.db
        .from("mobile_runs")
        .update({
          encrypted_result: encrypt(JSON.stringify(result), this.encryptionKey),
          encrypted_request: null,
          status: descriptors.length === 3 ? "succeeded" : "partial_success",
          phase: "completed",
          completed_at: new Date().toISOString(),
          expires_at: expiresAt,
        })
        .eq("id", runId);
      if (error) throw error;
      return descriptors;
    } catch (error) {
      if (uploadedPaths.length > 0) {
        await this.db.storage
          .from(ARTIFACT_BUCKET)
          .remove(uploadedPaths)
          .catch(() => {});
      }
      try {
        await this.db.from("mobile_run_artifacts").delete().eq("run_id", runId);
      } catch {
        // The original packaging error is more useful than best-effort cleanup errors.
      }
      throw error;
    }
  }

  async beginClaim(userId: string, runId: string): Promise<MobileRunClaimSession | null> {
    const { data, error } = await this.db
      .from("mobile_runs")
      .select("encrypted_result,status,completed_at,expires_at,claimed_at")
      .eq("id", runId)
      .eq("user_id", userId)
      .in("status", ["succeeded", "partial_success"])
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (error) throw error;
    if (!data || data.claimed_at || !data.encrypted_result || !data.completed_at) {
      return null;
    }

    const result = JSON.parse(
      decrypt(data.encrypted_result, this.encryptionKey)
    ) as StoredResult;
    const artifacts = await this.getArtifacts(runId);
    const manifestHash = createHash("sha256")
      .update(
        mobileClaimManifestJson({
          runId,
          ...result,
          generatedAt: data.completed_at,
          artifacts,
        })
      )
      .digest("hex");
    const claimToken = randomBytes(32).toString("base64url");
    const claimTokenHash = hashClaimToken(claimToken);
    const claimExpiresAt = new Date(
      Math.min(Date.now() + CLAIM_TTL_MS, new Date(data.expires_at).getTime())
    ).toISOString();
    const { data: updated, error: updateError } = await this.db
      .from("mobile_runs")
      .update({
        claim_token_hash: claimTokenHash,
        claim_manifest_hash: manifestHash,
        claim_started_at: new Date().toISOString(),
        claim_expires_at: claimExpiresAt,
      })
      .eq("id", runId)
      .eq("user_id", userId)
      .is("claimed_at", null)
      .select("id")
      .maybeSingle();
    if (updateError) throw updateError;
    if (!updated) return null;

    return MobileRunClaimSessionSchema.parse({
      claimToken,
      claimExpiresAt,
      manifestHash,
      ...result,
      generatedAt: data.completed_at,
      artifacts,
    });
  }

  async acknowledgeClaim(
    userId: string,
    runId: string,
    acknowledgement: MobileRunClaimAcknowledgementRequest
  ): Promise<MobileRunClaimAcknowledgement | null> {
    const { data, error } = await this.db.rpc("acknowledge_mobile_run", {
      acknowledged_run_id: runId,
      acknowledged_user_id: userId,
      acknowledged_token_hash: hashClaimToken(acknowledgement.claimToken),
      acknowledged_manifest_hash: acknowledgement.manifestHash,
    });
    if (error) throw error;
    if (!data) return null;
    const parsed = MobileRunClaimAcknowledgementSchema.parse(data);

    const now = new Date().toISOString();
    const { error: expireError } = await this.db
      .from("mobile_run_artifacts")
      .update({ expires_at: now })
      .eq("run_id", runId);
    if (expireError) throw expireError;
    await this.deleteRunArtifacts(runId);
    return parsed;
  }

  async downloadArtifact(
    userId: string,
    runId: string,
    artifactId: string,
    claimToken: string
  ): Promise<{ descriptor: MobileArtifactDescriptor; bytes: Buffer } | null> {
    const { data, error } = await this.db
      .from("mobile_run_artifacts")
      .select(
        "*,mobile_runs!inner(user_id,claimed_at,claim_token_hash,claim_expires_at,expires_at)"
      )
      .eq("id", artifactId)
      .eq("run_id", runId)
      .eq("mobile_runs.user_id", userId)
      .gt("mobile_runs.expires_at", new Date().toISOString())
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;

    const joinedRun = firstJoinedRun(data.mobile_runs);
    if (
      !joinedRun ||
      joinedRun.claimed_at !== null ||
      !joinedRun.claim_token_hash ||
      !joinedRun.claim_expires_at ||
      new Date(joinedRun.claim_expires_at).getTime() <= Date.now() ||
      !safeHashEqual(joinedRun.claim_token_hash, hashClaimToken(claimToken))
    ) {
      return null;
    }

    const artifact = data as unknown as DbMobileArtifact;
    const { data: encryptedBlob, error: downloadError } = await this.db.storage
      .from(ARTIFACT_BUCKET)
      .download(artifact.storage_path);
    if (downloadError) throw downloadError;
    return {
      descriptor: this.toArtifactDescriptor(artifact),
      bytes: decryptBytes(
        new Uint8Array(await encryptedBlob.arrayBuffer()),
        this.encryptionKey
      ),
    };
  }

  private async ensureUser(userId: string): Promise<DbMobileUser> {
    const { data, error } = await this.db
      .from("mobile_users")
      .upsert({ id: userId }, { onConflict: "id" })
      .select("id,entitlement,successful_run_count")
      .single();
    if (error) throw error;
    return data as DbMobileUser;
  }

  async interruptActiveRuns(): Promise<void> {
    const { error } = await this.db
      .from("mobile_runs")
      .update({
        status: "interrupted",
        phase: "failed",
        error_code: "SERVICE_RESTARTED",
        retryable: true,
        encrypted_request: null,
        challenge_method: null,
        challenge_deadline: null,
        completed_at: new Date().toISOString(),
      })
      .in("status", ["queued", "running", "awaiting_2fa", "packaging"]);
    if (error) throw error;
  }

  private async ensureUserCanRun(userId: string, profileId: string): Promise<void> {
    const me = await this.getMe(userId);
    if (me.serviceStatus !== "available") throw new Error("SERVICE_MAINTENANCE");
    if (me.remainingFreeRuns === 0) throw new Error("FREE_RUN_LIMIT");
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const { count: dailyRunCount, error: dailyRunError } = await this.db
      .from("mobile_runs")
      .select("id", { count: "exact", head: true })
      .gte("created_at", startOfDay.toISOString());
    if (dailyRunError) throw dailyRunError;
    if ((dailyRunCount ?? 0) >= this.maxDailyRuns) {
      throw new Error("BETA_DAILY_LIMIT");
    }
    const { data, error } = await this.db
      .from("mobile_profile_slots")
      .select("id")
      .eq("id", profileId)
      .eq("user_id", userId)
      .eq("is_active", true)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("PROFILE_NOT_FOUND");
  }

  private async getArtifacts(runId: string): Promise<MobileArtifactDescriptor[]> {
    const { data, error } = await this.db
      .from("mobile_run_artifacts")
      .select()
      .eq("run_id", runId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return (data ?? []).map((artifact) =>
      this.toArtifactDescriptor(artifact as DbMobileArtifact)
    );
  }

  private async deleteRunArtifacts(runId: string): Promise<void> {
    const { data, error } = await this.db
      .from("mobile_run_artifacts")
      .select("id,storage_path")
      .eq("run_id", runId);
    if (error) throw error;
    const artifacts = data ?? [];
    if (artifacts.length === 0) return;
    const { error: storageError } = await this.db.storage
      .from(ARTIFACT_BUCKET)
      .remove(artifacts.map((artifact) => artifact.storage_path));
    if (storageError) throw storageError;
    const { error: deleteError } = await this.db
      .from("mobile_run_artifacts")
      .delete()
      .eq("run_id", runId);
    if (deleteError) throw deleteError;
  }

  private toArtifactDescriptor(artifact: DbMobileArtifact): MobileArtifactDescriptor {
    return {
      id: artifact.id,
      kind: artifact.kind,
      filename: artifact.filename,
      contentType: artifact.content_type,
      byteLength: artifact.byte_length,
      sha256: artifact.sha256,
    };
  }

  private toSnapshot(
    run: DbMobileRun,
    artifacts: MobileArtifactDescriptor[]
  ): MobileRunSnapshot {
    const deadlineMs = run.challenge_deadline
      ? new Date(run.challenge_deadline).getTime()
      : undefined;
    return {
      id: run.id,
      clientRunId: run.id,
      profileId: run.profile_id,
      purpose: run.purpose,
      status: run.status,
      ...(run.phase ? { phase: run.phase } : {}),
      ...(run.status === "awaiting_2fa" && run.challenge_method && deadlineMs
        ? {
            challenge: {
              type: "security_code" as const,
              deliveryMethod: run.challenge_method,
              deadlineMs,
            },
          }
        : {}),
      ...(run.retryable !== null ? { retryable: run.retryable } : {}),
      ...(run.error_code ? { errorCode: run.error_code } : {}),
      ...(artifacts.length > 0 ? { artifacts } : {}),
      createdAt: run.created_at,
      updatedAt: run.updated_at,
    };
  }
}

interface JoinedClaimRun {
  claimed_at: string | null;
  claim_token_hash: string | null;
  claim_expires_at: string | null;
}

function firstJoinedRun(value: unknown): JoinedClaimRun | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== "object") return null;
  return candidate as JoinedClaimRun;
}

function hashClaimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeHashEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
