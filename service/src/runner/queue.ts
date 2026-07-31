export type QueueJobState = "queued" | "running" | "completed" | "failed" | "cancelled";

export type QueueTerminalStatus = "cancelled" | "interrupted";

export class QueueJobCancelledError extends Error {
  readonly terminalStatus: QueueTerminalStatus;

  constructor(message: string, terminalStatus: QueueTerminalStatus = "cancelled") {
    super(message);
    this.name = "QueueJobCancelledError";
    this.terminalStatus = terminalStatus;
  }
}

type QueueItem = {
  id: string;
  key: string;
  telegramId: number;
  memberName: string;
  controller: AbortController;
  execute: (signal: AbortSignal) => Promise<void>;
  onPositionUpdate: (position: number) => void | Promise<void>;
  state: QueueJobState;
  cancelError?: QueueJobCancelledError;
  resolve: () => void;
  reject: (err: Error) => void;
  done: Promise<void>;
};

export interface QueueJobHandle {
  id: string;
  key: string;
  telegramId: number;
  memberName: string;
  signal: AbortSignal;
  done: Promise<void>;
  cancel: (reason?: string, status?: QueueTerminalStatus) => boolean;
  getState: () => QueueJobState;
}

export type EnqueueResult =
  | { accepted: true; handle: QueueJobHandle; position: number }
  | { accepted: false; handle: QueueJobHandle; position: number };

const queue: QueueItem[] = [];
const jobsById = new Map<string, QueueItem>();
const jobsByKey = new Map<string, QueueItem>();
const activeTelegramIds = new Set<number>();
let activeCount = 0;
let concurrency = 2;

export function setConcurrency(n: number): void {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError("Queue concurrency must be a positive integer");
  }
  concurrency = n;
  processQueue();
}

export function hasJob(key: string): boolean {
  return jobsByKey.has(key);
}

export function getQueueStats(): { active: number; waiting: number } {
  return { active: activeCount, waiting: queue.length };
}

export function getJobInfo(
  id: string
): { id: string; key: string; telegramId: number; state: QueueJobState } | undefined {
  const item = jobsById.get(id);
  if (!item) {
    return undefined;
  }
  return {
    id: item.id,
    key: item.key,
    telegramId: item.telegramId,
    state: item.state,
  };
}

const toHandle = (item: QueueItem): QueueJobHandle => ({
  id: item.id,
  key: item.key,
  telegramId: item.telegramId,
  memberName: item.memberName,
  signal: item.controller.signal,
  done: item.done,
  cancel: (reason, status) => cancelJob(item.id, reason, status),
  getState: () => item.state,
});

const waitingPosition = (item: QueueItem): number => {
  const index = queue.indexOf(item);
  return index < 0 ? 0 : index + 1;
};

export function enqueue(options: {
  id: string;
  key: string;
  telegramId: number;
  memberName: string;
  execute: (signal: AbortSignal) => Promise<void>;
  onPositionUpdate: (position: number) => void | Promise<void>;
}): EnqueueResult {
  const existing = jobsByKey.get(options.key);
  if (existing) {
    return {
      accepted: false,
      handle: toHandle(existing),
      position: waitingPosition(existing),
    };
  }

  let resolveDone!: () => void;
  let rejectDone!: (err: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => {});

  const item: QueueItem = {
    id: options.id,
    key: options.key,
    telegramId: options.telegramId,
    memberName: options.memberName,
    controller: new AbortController(),
    execute: options.execute,
    onPositionUpdate: options.onPositionUpdate,
    state: "queued",
    resolve: resolveDone,
    reject: rejectDone,
    done,
  };

  queue.push(item);
  jobsById.set(item.id, item);
  jobsByKey.set(item.key, item);
  processQueue();

  return { accepted: true, handle: toHandle(item), position: waitingPosition(item) };
}

export function cancelJob(
  id: string,
  reason = "Run cancelled",
  status: QueueTerminalStatus = "cancelled"
): boolean {
  const item = jobsById.get(id);
  if (!item || ["completed", "failed", "cancelled"].includes(item.state)) {
    return false;
  }

  const error = new QueueJobCancelledError(reason, status);

  if (item.state === "queued") {
    const index = queue.indexOf(item);
    if (index >= 0) {
      queue.splice(index, 1);
    }
    item.state = "cancelled";
    item.controller.abort(error);
    jobsById.delete(item.id);
    jobsByKey.delete(item.key);
    item.reject(error);
    notifyPositions();
    return true;
  }

  item.state = "cancelled";
  item.cancelError = error;
  item.controller.abort(error);
  return true;
}

export function cancelAllJobs(
  reason = "Service shutting down",
  status: QueueTerminalStatus = "interrupted"
): string[] {
  const ids = Array.from(jobsById.keys());
  for (const id of ids) {
    cancelJob(id, reason, status);
  }
  return ids;
}

export async function waitForIdle(timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (jobsById.size > 0) {
    if (Date.now() - startedAt >= timeoutMs) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

function notifyPositions(): void {
  for (let i = 0; i < queue.length; i += 1) {
    notifyPosition(queue[i], i + 1);
  }
}

function notifyPosition(item: QueueItem, position: number): void {
  try {
    void Promise.resolve(item.onPositionUpdate(position)).catch(() => {});
  } catch {
    // Position notifications are best-effort and must not stall the queue.
  }
}

function processQueue(): void {
  while (activeCount < concurrency) {
    const nextIndex = queue.findIndex((item) => !activeTelegramIds.has(item.telegramId));
    if (nextIndex < 0) {
      break;
    }

    const [item] = queue.splice(nextIndex, 1);
    if (item?.state !== "queued") {
      continue;
    }

    item.state = "running";
    activeCount += 1;
    activeTelegramIds.add(item.telegramId);
    notifyPosition(item, 0);
    notifyPositions();

    let completionError: Error | undefined;
    let shouldResolve = false;

    item
      .execute(item.controller.signal)
      .then(() => {
        if (item.state === "cancelled") {
          return;
        }
        item.state = "completed";
        shouldResolve = true;
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (item.state === "cancelled") {
          item.cancelError ??=
            error instanceof QueueJobCancelledError
              ? error
              : new QueueJobCancelledError(error.message);
          return;
        }
        if (error instanceof QueueJobCancelledError) {
          item.state = "cancelled";
          item.cancelError = error;
          return;
        }
        item.state = "failed";
        completionError = error;
      })
      .finally(() => {
        activeCount -= 1;
        activeTelegramIds.delete(item.telegramId);
        jobsById.delete(item.id);
        jobsByKey.delete(item.key);
        if (item.state === "cancelled") {
          item.reject(item.cancelError ?? new QueueJobCancelledError("Run cancelled"));
        } else if (completionError) {
          item.reject(completionError);
        } else if (shouldResolve) {
          item.resolve();
        }
        processQueue();
      });
  }
}

export function resetQueueForTests(): void {
  for (const item of jobsById.values()) {
    item.controller.abort(new QueueJobCancelledError("Reset"));
    item.reject(new QueueJobCancelledError("Reset"));
  }
  queue.splice(0, queue.length);
  jobsById.clear();
  jobsByKey.clear();
  activeTelegramIds.clear();
  activeCount = 0;
  concurrency = 2;
}
