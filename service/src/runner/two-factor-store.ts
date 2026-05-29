import type { TwoFactorMethod } from "evisa-flow";

/**
 * Channel-agnostic 2FA gate store.
 *
 * A pending request is keyed solely by `requestId` (the runId). Channels resolve
 * it by that id: the web channel POSTs the runId; the Telegram channel maps an
 * incoming reply to a runId in its own adapter
 * ({@link file://./../bot/two-factor-adapter.ts}) before calling
 * {@link resolveCode}. The store itself holds no channel-specific routing.
 */

interface PendingRequest {
  requestId: string;
  resolve: (code: string) => void;
  reject: (err: Error) => void;
  method: TwoFactorMethod;
  memberName: string;
  timeoutHandle: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort: () => void;
}

const pending = new Map<string, PendingRequest>();

/** Whether a 2FA request is currently awaiting a code for this requestId. */
export function hasPending(requestId: string): boolean {
  return pending.has(requestId);
}

export function resolveCode(requestId: string, code: string): boolean {
  const req = pending.get(requestId);
  if (!req) return false;

  clearTimeout(req.timeoutHandle);
  cleanup(req);
  req.resolve(code);
  return true;
}

export function cancelRequest(requestId: string, reason = "2FA cancelled"): boolean {
  const req = pending.get(requestId);
  if (!req) {
    return false;
  }
  clearTimeout(req.timeoutHandle);
  cleanup(req);
  req.reject(new Error(reason));
  return true;
}

export function requestCode(options: {
  requestId: string;
  method: TwoFactorMethod;
  memberName: string;
  deadlineMs: number;
  signal?: AbortSignal;
}): Promise<string> {
  const existing = pending.get(options.requestId);
  if (existing) {
    clearTimeout(existing.timeoutHandle);
    cleanup(existing);
    existing.reject(new Error("Superseded by new request"));
  }

  return new Promise<string>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(`2FA cancelled for ${options.memberName}`));
      return;
    }

    let req!: PendingRequest;
    const onAbort = () => {
      clearTimeout(req.timeoutHandle);
      cleanup(req);
      reject(new Error(`2FA cancelled for ${options.memberName}`));
    };
    const timeoutHandle = setTimeout(
      () => {
        cleanup(req);
        reject(new Error(`2FA timeout for ${options.memberName}`));
      },
      Math.max(0, options.deadlineMs - Date.now())
    );

    req = {
      requestId: options.requestId,
      resolve: (code) => {
        cleanup(req);
        resolve(code);
      },
      reject: (error) => {
        cleanup(req);
        reject(error);
      },
      method: options.method,
      memberName: options.memberName,
      timeoutHandle,
      signal: options.signal,
      onAbort,
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(options.requestId, req);
  });
}

function cleanup(req: PendingRequest): void {
  pending.delete(req.requestId);
  req.signal?.removeEventListener("abort", req.onAbort);
}

export function resetPendingForTests(): void {
  for (const req of pending.values()) {
    clearTimeout(req.timeoutHandle);
    req.reject(new Error("Reset"));
  }
  pending.clear();
}
