/**
 * `useRunStream` — subscribes to a run's SSE timeline and reduces it to a single
 * UI-friendly state object.
 *
 * The native `EventSource` handles reconnects for us: on a dropped connection it
 * automatically reconnects and replays `Last-Event-ID`, and the server's run bus
 * replays the backlog while the SSE helper skips frames the client already saw —
 * so the reducer here just keeps applying events idempotently. We listen for the
 * named events the server emits (`event: <type>`), parse each `data:` JSON
 * payload into a {@link RunEvent}, and close the stream once a terminal event
 * (`completed`/`failed`) arrives.
 *
 * The hook does NOT do any crypto: the sealed share code bytes and the artifact
 * list ids are surfaced raw so the run screen can open them with the vault key
 * and fetch the sealed artifact bytes. This keeps the network/streaming concern
 * separate from the in-browser decryption concern.
 */
import { useEffect, useRef, useState } from "react";
import { runEventsUrl } from "./api-client.js";
import {
  decodeJsonBytes,
  type RunEvent,
  type SealedArtifactRef,
  TERMINAL_EVENT_TYPES,
} from "./run-events.js";

/** The reduced, render-ready state of a run. */
export interface RunStreamState {
  /** Connection lifecycle for the stream itself. */
  connection: "connecting" | "open" | "reconnecting" | "closed";
  /** Coarse run phase derived from events. */
  status: "queued" | "running" | "awaiting_2fa" | "completed" | "failed" | "unknown";
  /** Queue position + active count while queued. */
  queue?: { position: number; active: number };
  /** Latest phase label (e.g. "Signing in", "Downloading PDF"). */
  phaseLabel?: string;
  /** When awaiting 2FA: the channel and the absolute deadline (ms epoch). */
  challenge?: { method: "sms" | "email"; deadlineAt: number };
  /** Sealed-artifact refs announced via `artifact_ready` (true filenames inside). */
  artifacts: SealedArtifactRef[];
  /** Terminal success payload: validity + sealed share-code bytes (still sealed). */
  completed?: { validUntil?: string; sealedShareCode?: Uint8Array };
  /** Terminal failure payload. */
  failure?: { code: string; message: string; cause?: "cancelled" | "interrupted" };
}

const INITIAL: RunStreamState = {
  connection: "connecting",
  status: "unknown",
  artifacts: [],
};

/** Applies one {@link RunEvent} to the reducer state (pure, idempotent enough). */
function reduce(state: RunStreamState, event: RunEvent): RunStreamState {
  switch (event.type) {
    case "queued":
      return {
        ...state,
        status: "queued",
        queue: { position: event.position, active: event.active },
      };
    case "started":
      return { ...state, status: "running", queue: undefined };
    case "phase":
      return { ...state, status: "running", phaseLabel: event.label };
    case "timing":
      return state; // Timing frames are informational; ignored for the UI.
    case "challenge_required":
      return {
        ...state,
        status: "awaiting_2fa",
        challenge: {
          method: event.method,
          // The server sends a relative deadline; anchor it to now for a countdown.
          deadlineAt: Date.now() + event.deadlineMs,
        },
      };
    case "artifact_ready":
      // De-dupe by kind in case a backlog replay re-delivers the same artifact.
      return {
        ...state,
        artifacts: [
          ...state.artifacts.filter((a) => a.kind !== event.artifact.kind),
          event.artifact,
        ],
      };
    case "completed": {
      // Reconstruct the sealed share-code bytes from the JSON-serialised form
      // (a Uint8Array becomes an index→byte object across JSON).
      const blob = event.sealedShareCode;
      const bytes = blob?.alg === "box_seal" ? decodeJsonBytes(blob.bytes) : undefined;
      return {
        ...state,
        status: "completed",
        challenge: undefined,
        completed: { validUntil: event.validUntil, sealedShareCode: bytes },
      };
    }
    case "failed":
      return {
        ...state,
        status: "failed",
        challenge: undefined,
        failure: { code: event.code, message: event.message, cause: event.cause },
      };
  }
}

/**
 * Opens an SSE stream for `runId` (when non-null) and returns the reduced state.
 * Pass `runId = null` to keep the stream closed (e.g. before a run is created).
 * The stream is torn down on unmount or when `runId` changes.
 */
export function useRunStream(runId: string | null): RunStreamState {
  const [state, setState] = useState<RunStreamState>(INITIAL);
  // Track terminal-ness in a ref so the message handler can close the source
  // without re-creating the effect.
  const closedRef = useRef(false);

  useEffect(() => {
    if (!runId) {
      setState(INITIAL);
      return;
    }
    setState(INITIAL);
    closedRef.current = false;

    const source = new EventSource(runEventsUrl(runId), { withCredentials: true });

    const onOpen = (): void => {
      setState((s) => (s.connection === "open" ? s : { ...s, connection: "open" }));
    };

    const handle = (raw: MessageEvent): void => {
      let event: RunEvent;
      try {
        event = JSON.parse(raw.data) as RunEvent;
      } catch {
        return; // Ignore malformed frames (e.g. a stray comment) defensively.
      }
      setState((s) => reduce({ ...s, connection: "open" }, event));
      if (TERMINAL_EVENT_TYPES.has(event.type)) {
        closedRef.current = true;
        source.close();
        setState((s) => ({ ...s, connection: "closed" }));
      }
    };

    const onError = (): void => {
      // EventSource auto-reconnects unless we've already closed on a terminal
      // event. Reflect "reconnecting" only while it will actually retry.
      if (closedRef.current) return;
      setState((s) => ({ ...s, connection: "reconnecting" }));
    };

    source.addEventListener("open", onOpen);
    source.addEventListener("error", onError);
    // The server names every frame by event type; listen for each.
    for (const type of [
      "queued",
      "started",
      "phase",
      "timing",
      "challenge_required",
      "artifact_ready",
      "completed",
      "failed",
    ]) {
      source.addEventListener(type, handle as EventListener);
    }
    // Also catch unnamed frames (defensive: a generic `message`).
    source.addEventListener("message", handle as EventListener);

    return () => {
      closedRef.current = true;
      source.close();
    };
  }, [runId]);

  return state;
}
