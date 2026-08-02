import {
  type MobileApiError,
  MobileApiErrorSchema,
  type MobileArtifactDescriptor,
  type MobileChallengeSubmission,
  type MobileMe,
  MobileMeSchema,
  type MobileProfileSlotRequest,
  type MobileRunClaimAcknowledgement,
  type MobileRunClaimAcknowledgementRequest,
  MobileRunClaimAcknowledgementSchema,
  type MobileRunClaimSession,
  MobileRunClaimSessionSchema,
  type MobileRunCreateRequest,
  type MobileRunEvent,
  MobileRunEventSchema,
  type MobileRunSnapshot,
  MobileRunSnapshotSchema,
} from "@evisa-flow/protocol";
import { fetch as expoFetch } from "expo/fetch";
import { ServerSentEventParser } from "./sse";

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
  beginClaim(runId: string): Promise<MobileRunClaimSession>;
  acknowledgeClaim(
    runId: string,
    request: MobileRunClaimAcknowledgementRequest
  ): Promise<MobileRunClaimAcknowledgement>;
  downloadArtifact(
    runId: string,
    artifact: MobileArtifactDescriptor,
    claimToken: string
  ): Promise<Uint8Array>;
  streamRunEvents(
    runId: string,
    options: {
      lastEventId?: number;
      signal: AbortSignal;
      onEvent: (event: MobileRunEvent) => void;
    }
  ): Promise<void>;
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

  async beginClaim(runId: string): Promise<MobileRunClaimSession> {
    return MobileRunClaimSessionSchema.parse(
      await this.requestJson(`/v1/runs/${encodeURIComponent(runId)}/claim-result`, {
        method: "POST",
      })
    );
  }

  async acknowledgeClaim(
    runId: string,
    request: MobileRunClaimAcknowledgementRequest
  ): Promise<MobileRunClaimAcknowledgement> {
    return MobileRunClaimAcknowledgementSchema.parse(
      await this.requestJson(
        `/v1/runs/${encodeURIComponent(runId)}/claim-result/acknowledge`,
        { method: "POST", body: JSON.stringify(request) }
      )
    );
  }

  async downloadArtifact(
    runId: string,
    artifact: MobileArtifactDescriptor,
    claimToken: string
  ): Promise<Uint8Array> {
    const response = await this.request(
      `/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifact.id)}`,
      { headers: { "X-EVisaFlow-Claim-Token": claimToken } }
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  async streamRunEvents(
    runId: string,
    options: {
      lastEventId?: number;
      signal: AbortSignal;
      onEvent: (event: MobileRunEvent) => void;
    }
  ): Promise<void> {
    const accessToken = await this.getAccessToken();
    let response: Awaited<ReturnType<typeof expoFetch>>;
    try {
      response = await expoFetch(
        `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`,
        {
          signal: options.signal,
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${accessToken}`,
            ...(options.lastEventId !== undefined
              ? { "Last-Event-ID": String(options.lastEventId) }
              : {}),
          },
        }
      );
    } catch {
      if (options.signal.aborted) return;
      throw networkError("The live run connection could not be opened.");
    }
    if (!response.ok) {
      throw await this.responseError(response);
    }
    if (!response.headers.get("content-type")?.startsWith("text/event-stream")) {
      throw networkError("The live run connection returned an unexpected response.");
    }
    if (!response.body) throw networkError("The live run connection is unavailable.");

    const parser = new ServerSentEventParser();
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    try {
      while (!options.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const message of parser.push(decoder.decode(value, { stream: true }))) {
          const parsed = MobileRunEventSchema.safeParse(JSON.parse(message.data));
          if (parsed.success) options.onEvent(parsed.data);
        }
      }
    } catch (error) {
      if (!options.signal.aborted) throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
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

    throw await this.responseError(response);
  }

  private async responseError(response: {
    status: number;
    json: () => Promise<unknown>;
  }): Promise<MobileApiRequestError> {
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
    return new MobileApiRequestError(response.status, body);
  }
}

function networkError(message: string): MobileApiRequestError {
  return new MobileApiRequestError(0, {
    code: "NETWORK_UNAVAILABLE",
    message,
    retryable: true,
  });
}
