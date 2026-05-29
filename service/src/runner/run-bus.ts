import type { RunEvent, RunSnapshot } from "./run-engine.js";

/**
 * Channel-agnostic run event bus.
 *
 * v1 is a single-process, in-memory implementation backed by a
 * `Map<runId, Topic>`. Each topic keeps an append-only backlog plus the latest
 * derived {@link RunSnapshot}. `subscribe()` first replays the backlog (so a
 * late SSE reconnect or the bot catches every prior phase) and then tails live
 * events through a bounded async push-queue.
 *
 * A terminal event (`completed`/`failed`) flushes all current subscribers and
 * then schedules topic teardown after a short grace window, leaving enough time
 * for late joiners to replay the final state.
 *
 * The interface is deliberately Redis-shaped: a future multi-worker version can
 * back `publish` with `PUBLISH` + a capped stream and `subscribe` with
 * `SUBSCRIBE` + `XRANGE` replay without changing callers.
 */
export interface RunBus {
  publish(runId: string, event: RunEvent): void;
  subscribe(runId: string): AsyncIterable<RunEvent>;
  snapshot(runId: string): RunSnapshot | undefined;
  close(runId: string): void;
}

export interface RunBusOptions {
  /**
   * How long a terminated topic lingers (after flushing) so late subscribers
   * can still replay the terminal backlog. Defaults to 30s.
   */
  terminalGraceMs?: number;
  /**
   * Maximum number of buffered events per slow subscriber before the oldest is
   * dropped. Bounds memory under back-pressure. Defaults to 1024.
   */
  maxQueuePerSubscriber?: number;
}

const DEFAULT_TERMINAL_GRACE_MS = 30_000;
const DEFAULT_MAX_QUEUE_PER_SUBSCRIBER = 1024;

function isTerminalEvent(event: RunEvent): boolean {
  return event.type === "completed" || event.type === "failed";
}

/** Per-subscriber bounded queue with async hand-off and end-of-stream signal. */
class SubscriberQueue {
  private readonly buffer: RunEvent[] = [];
  private resolveNext: ((value: IteratorResult<RunEvent>) => void) | undefined;
  private ended = false;

  constructor(private readonly maxQueue: number) {}

  push(event: RunEvent): void {
    if (this.ended) {
      return;
    }
    if (this.resolveNext) {
      const resolve = this.resolveNext;
      this.resolveNext = undefined;
      resolve({ value: event, done: false });
      return;
    }
    this.buffer.push(event);
    // Bound memory: drop the oldest event for a subscriber that cannot keep up.
    while (this.buffer.length > this.maxQueue) {
      this.buffer.shift();
    }
  }

  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    if (this.resolveNext) {
      const resolve = this.resolveNext;
      this.resolveNext = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<RunEvent>> {
    if (this.buffer.length > 0) {
      const value = this.buffer.shift() as RunEvent;
      return Promise.resolve({ value, done: false });
    }
    if (this.ended) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise<IteratorResult<RunEvent>>((resolve) => {
      this.resolveNext = resolve;
    });
  }
}

interface Topic {
  backlog: RunEvent[];
  snapshot: RunSnapshot;
  subscribers: Set<SubscriberQueue>;
  terminal: boolean;
  teardownTimer?: ReturnType<typeof setTimeout>;
}

function applyEvent(snapshot: RunSnapshot, event: RunEvent): RunSnapshot {
  const next: RunSnapshot = { ...snapshot, lastEvent: event };
  switch (event.type) {
    case "queued":
      next.status = "queued";
      next.position = event.position;
      next.active = event.active;
      break;
    case "started":
      next.status = "running";
      next.position = 0;
      break;
    case "phase":
      next.status = "running";
      next.phase = event.phase;
      next.phaseLabel = event.label;
      break;
    case "challenge_required":
      next.status = "awaiting_2fa";
      next.challengeMethod = event.method;
      next.challengeDeadlineMs = event.deadlineMs;
      break;
    case "completed":
      next.status = "completed";
      next.validUntil = event.validUntil;
      break;
    case "failed":
      next.status = "failed";
      next.errorCode = event.code;
      next.errorMessage = event.message;
      break;
    default:
      break;
  }
  return next;
}

export function createInMemoryRunBus(options: RunBusOptions = {}): RunBus {
  const terminalGraceMs = options.terminalGraceMs ?? DEFAULT_TERMINAL_GRACE_MS;
  const maxQueuePerSubscriber =
    options.maxQueuePerSubscriber ?? DEFAULT_MAX_QUEUE_PER_SUBSCRIBER;
  const topics = new Map<string, Topic>();

  function getOrCreateTopic(runId: string): Topic {
    let topic = topics.get(runId);
    if (!topic) {
      topic = {
        backlog: [],
        snapshot: { runId, status: "queued" },
        subscribers: new Set(),
        terminal: false,
      };
      topics.set(runId, topic);
    }
    return topic;
  }

  function scheduleTeardown(runId: string, topic: Topic): void {
    if (topic.teardownTimer) {
      clearTimeout(topic.teardownTimer);
    }
    topic.teardownTimer = setTimeout(() => {
      // Re-check identity in case a new run reused the id in the interim.
      if (topics.get(runId) === topic) {
        topics.delete(runId);
      }
    }, terminalGraceMs);
    // Do not keep the event loop alive solely for teardown.
    topic.teardownTimer.unref?.();
  }

  return {
    publish(runId, event) {
      const topic = getOrCreateTopic(runId);
      if (topic.terminal) {
        // Ignore anything published after a terminal event.
        return;
      }
      topic.snapshot = applyEvent(topic.snapshot, event);
      topic.backlog.push(event);
      for (const subscriber of topic.subscribers) {
        subscriber.push(event);
      }
      if (isTerminalEvent(event)) {
        topic.terminal = true;
        // Flush subscribers: deliver end-of-stream after the terminal event.
        for (const subscriber of topic.subscribers) {
          subscriber.end();
        }
        topic.subscribers.clear();
        scheduleTeardown(runId, topic);
      }
    },

    subscribe(runId) {
      const topic = getOrCreateTopic(runId);
      const queue = new SubscriberQueue(maxQueuePerSubscriber);
      // Replay backlog first so late joiners see every prior phase.
      const replay = [...topic.backlog];
      const alreadyTerminal = topic.terminal;
      if (alreadyTerminal) {
        // Terminal topic: replay then immediately end; do not register as a
        // live subscriber (no further events will arrive).
        for (const event of replay) {
          queue.push(event);
        }
        queue.end();
      } else {
        topic.subscribers.add(queue);
        for (const event of replay) {
          queue.push(event);
        }
      }

      return {
        [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
          return {
            next: () => queue.next(),
            return: () => {
              topic.subscribers.delete(queue);
              queue.end();
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      };
    },

    snapshot(runId) {
      return topics.get(runId)?.snapshot;
    },

    close(runId) {
      const topic = topics.get(runId);
      if (!topic) {
        return;
      }
      if (topic.teardownTimer) {
        clearTimeout(topic.teardownTimer);
      }
      for (const subscriber of topic.subscribers) {
        subscriber.end();
      }
      topic.subscribers.clear();
      topics.delete(runId);
    },
  };
}
