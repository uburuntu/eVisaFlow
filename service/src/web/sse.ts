import type { FastifyReply, FastifyRequest } from "fastify";
import type { RunEvent } from "../runner/run-types.js";
import type { Logger } from "../utils/logger.js";

/**
 * Server-Sent Events helper for streaming a run's {@link RunEvent} timeline to a
 * browser `EventSource`.
 *
 * Design notes:
 * - We take over the raw socket with {@link FastifyReply.hijack} and write the
 *   `text/event-stream` response directly on `reply.raw` (the Node
 *   `ServerResponse`). Fastify then leaves the response alone — no body
 *   serialization, no `onSend` hooks, no automatic `Content-Length` — which is
 *   exactly what an open-ended stream needs.
 * - Each frame carries a monotonic `id:` so a reconnecting client sends back
 *   `Last-Event-ID`; the engine's run bus already replays the full backlog on
 *   subscribe, so on reconnect we re-emit that backlog and SKIP everything at or
 *   below the id the client already saw (idempotent resume without server-side
 *   per-connection cursors).
 * - A periodic heartbeat comment (`: ping`) keeps intermediaries (proxies, load
 *   balancers) from idling the connection out.
 * - On client disconnect/abort we return the async iterator (releasing the bus
 *   subscriber) and clear the heartbeat, so a closed tab never leaks a
 *   subscription or a timer.
 */

/** SSE response headers. `no-transform` stops proxies from buffering/altering. */
const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Disable proxy buffering (nginx) so events flush immediately.
  "x-accel-buffering": "no",
};

/** Default heartbeat cadence — frequent enough to survive common 60s idle timeouts. */
const DEFAULT_HEARTBEAT_MS = 15_000;

export interface StreamRunEventsOptions {
  /** Heartbeat interval in ms. Defaults to {@link DEFAULT_HEARTBEAT_MS}. */
  heartbeatMs?: number;
  log?: Logger;
}

/**
 * Reads the resume cursor from a request: the `Last-Event-ID` header (set
 * automatically by the browser's `EventSource` on reconnect) or, as a fallback
 * for manual clients, a `?lastEventId=` query param. Returns the numeric id the
 * client last received, or -1 when starting fresh (so id 0 is not skipped).
 */
export function readLastEventId(request: FastifyRequest): number {
  const header = request.headers["last-event-id"];
  const raw = Array.isArray(header) ? header[0] : header;
  const fromQuery = (request.query as { lastEventId?: string } | undefined)?.lastEventId;
  const value = raw ?? fromQuery;
  if (value === undefined) return -1;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

/** Serializes one SSE frame: `id:` + `event:` + (multi-line-safe) `data:` block. */
function formatFrame(id: number, event: RunEvent): string {
  // `data:` must not contain raw newlines; JSON.stringify never emits them, but
  // split-and-prefix anyway so any future multi-line payload stays valid SSE.
  const payload = JSON.stringify(event);
  const dataLines = payload
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
  return `id: ${id}\nevent: ${event.type}\n${dataLines}\n\n`;
}

/**
 * Streams an `AsyncIterable<RunEvent>` to the client as `text/event-stream` until
 * the stream ends (the run reaches a terminal event) or the client disconnects.
 *
 * Resume: events are numbered by their position in the bus backlog (0-based). On
 * a reconnect carrying `Last-Event-ID = N`, the replayed backlog frames with id
 * `<= N` are skipped, so the client receives only what it missed exactly once.
 *
 * This function hijacks the reply and resolves only after the response has been
 * fully ended (terminal event flushed or socket closed). The caller should
 * `await` it but must not touch `reply` afterward.
 */
export async function streamRunEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  events: AsyncIterable<RunEvent>,
  options: StreamRunEventsOptions = {}
): Promise<void> {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const log = options.log;
  const lastSeenId = readLastEventId(request);

  // Take over the socket: Fastify will not send its own response after this.
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, SSE_HEADERS);
  // Prime the stream with a comment so the client's connection opens immediately
  // even before the first real event (and proxies see bytes right away).
  res.write(": connected\n\n");

  // Get the underlying iterator so we can both pull events AND deterministically
  // release the bus subscriber (via `return()`) on disconnect.
  const iterator = events[Symbol.asyncIterator]();

  const heartbeat = setInterval(() => {
    // A comment line is ignored by EventSource but keeps the socket warm.
    if (!res.writableEnded) res.write(": ping\n\n");
  }, heartbeatMs);
  heartbeat.unref?.();

  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    // Release the bus subscription (its async-iterator `return` deletes the
    // subscriber and ends its queue). Best-effort; ignore teardown errors.
    void iterator.return?.().catch(() => {});
  };

  // Client went away (tab closed, navigation, network drop): stop streaming and
  // release resources. `aborted` fires on abrupt resets; `close` on normal end.
  request.raw.on("close", cleanup);
  request.raw.on("aborted", cleanup);

  try {
    // The bus assigns ids by backlog position; mirror that with a counter so the
    // id we send matches what a later reconnect compares against.
    let id = 0;
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      const eventId = id++;
      if (closed || res.writableEnded) break;
      // Skip backlog the client already received on a prior connection.
      if (eventId <= lastSeenId) continue;
      res.write(formatFrame(eventId, next.value));
    }
  } catch (err) {
    log?.warn({ err }, "SSE stream error");
  } finally {
    cleanup();
    request.raw.off("close", cleanup);
    request.raw.off("aborted", cleanup);
    if (!res.writableEnded) res.end();
  }
}
