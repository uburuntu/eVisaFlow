import {
  type MobileApiError,
  MobileApiErrorSchema,
  type MobileArtifactDescriptor,
  type MobileChallengeSubmission,
  type MobileMe,
  MobileMeSchema,
  type MobileProfileSlotRequest,
  type MobileRunClaimResult,
  MobileRunClaimResultSchema,
  type MobileRunCreateRequest,
  type MobileRunSnapshot,
  MobileRunSnapshotSchema,
} from "@evisa-flow/protocol";

export class MobileApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, body: MobileApiError) {
    super(body.message);
    this.name = "MobileApiRequestError";
    this.status = status;
    this.code = body.code;
    this.retryable = body.retryable;
  }
}

export interface MobileApi {
  getMe(): Promise<MobileMe>;
  deleteAccount(): Promise<void>;
  putProfileSlot(slotId: string, request: MobileProfileSlotRequest): Promise<void>;
  deleteProfileSlot(slotId: string): Promise<void>;
  createRun(request: MobileRunCreateRequest): Promise<MobileRunSnapshot>;
  getRun(runId: string): Promise<MobileRunSnapshot>;
  submitChallenge(
    runId: string,
    request: MobileChallengeSubmission
  ): Promise<MobileRunSnapshot>;
  cancelRun(runId: string): Promise<MobileRunSnapshot>;
  claimResult(runId: string): Promise<MobileRunClaimResult>;
  downloadArtifact(
    runId: string,
    artifact: MobileArtifactDescriptor
  ): Promise<Uint8Array>;
}

export class MobileApiClient implements MobileApi {
  readonly baseUrl: string;
  readonly getAccessToken: () => Promise<string>;

  constructor(options: { baseUrl: string; getAccessToken: () => Promise<string> }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.getAccessToken = options.getAccessToken;
  }

  async getMe(): Promise<MobileMe> {
    return MobileMeSchema.parse(await this.requestJson("/v1/me"));
  }

  async deleteAccount(): Promise<void> {
    await this.requestJson("/v1/me", { method: "DELETE" });
  }

  async putProfileSlot(slotId: string, request: MobileProfileSlotRequest): Promise<void> {
    await this.requestJson(`/v1/profile-slots/${encodeURIComponent(slotId)}`, {
      method: "PUT",
      body: JSON.stringify(request),
    });
  }

  async deleteProfileSlot(slotId: string): Promise<void> {
    await this.requestJson(`/v1/profile-slots/${encodeURIComponent(slotId)}`, {
      method: "DELETE",
    });
  }

  async createRun(request: MobileRunCreateRequest): Promise<MobileRunSnapshot> {
    return MobileRunSnapshotSchema.parse(
      await this.requestJson("/v1/runs", {
        method: "POST",
        body: JSON.stringify(request),
      })
    );
  }

  async getRun(runId: string): Promise<MobileRunSnapshot> {
    return MobileRunSnapshotSchema.parse(
      await this.requestJson(`/v1/runs/${encodeURIComponent(runId)}`)
    );
  }

  async submitChallenge(
    runId: string,
    request: MobileChallengeSubmission
  ): Promise<MobileRunSnapshot> {
    return MobileRunSnapshotSchema.parse(
      await this.requestJson(`/v1/runs/${encodeURIComponent(runId)}/challenge`, {
        method: "POST",
        body: JSON.stringify(request),
      })
    );
  }

  async cancelRun(runId: string): Promise<MobileRunSnapshot> {
    return MobileRunSnapshotSchema.parse(
      await this.requestJson(`/v1/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
      })
    );
  }

  async claimResult(runId: string): Promise<MobileRunClaimResult> {
    return MobileRunClaimResultSchema.parse(
      await this.requestJson(`/v1/runs/${encodeURIComponent(runId)}/claim-result`, {
        method: "POST",
      })
    );
  }

  async downloadArtifact(
    runId: string,
    artifact: MobileArtifactDescriptor
  ): Promise<Uint8Array> {
    const response = await this.request(
      `/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifact.id)}`
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  private async requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.request(path, init);
    if (response.status === 204) {
      return undefined;
    }
    return response.json();
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const accessToken = await this.getAccessToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new MobileApiRequestError(0, {
        code: controller.signal.aborted ? "REQUEST_TIMEOUT" : "NETWORK_UNAVAILABLE",
        message: controller.signal.aborted
          ? "The secure service took too long to respond."
          : "The secure service could not be reached.",
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.ok) {
      return response;
    }

    let body: MobileApiError = {
      code: "HTTP_ERROR",
      message: "The eVisaFlow service could not complete the request.",
      retryable: response.status >= 500,
    };
    try {
      const parsed = MobileApiErrorSchema.safeParse(await response.json());
      if (parsed.success) {
        body = parsed.data;
      }
    } catch {
      // Keep the privacy-safe generic error when the server body is not JSON.
    }
    throw new MobileApiRequestError(response.status, body);
  }
}
