import type { TwoFactorMethod } from "evisa-flow";

interface PendingRequest {
  requestId: string;
  telegramId: number;
  resolve: (code: string) => void;
  reject: (err: Error) => void;
  method: TwoFactorMethod;
  memberName: string;
  sequence: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingRequest>();
let nextSequence = 0;

export function hasPending(telegramId: number): boolean {
  return Array.from(pending.values()).some((req) => req.telegramId === telegramId);
}

export function submitCode(telegramId: number, code: string): boolean {
  const req = Array.from(pending.values())
    .filter((item) => item.telegramId === telegramId)
    .sort((a, b) => b.sequence - a.sequence)[0];
  if (!req) return false;

  clearTimeout(req.timeoutHandle);
  pending.delete(req.requestId);
  req.resolve(code);
  return true;
}

export function requestCode(
  requestId: string,
  telegramId: number,
  method: TwoFactorMethod,
  memberName: string,
  deadlineMs: number,
  signal?: AbortSignal
): Promise<string> {
  const existing = pending.get(requestId);
  if (existing) {
    clearTimeout(existing.timeoutHandle);
    existing.reject(new Error("Superseded by new request"));
    pending.delete(requestId);
  }

  return new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      pending.delete(requestId);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      clearTimeout(timeoutHandle);
      cleanup();
      reject(new Error(`2FA cancelled for ${memberName}`));
    };
    const timeoutHandle = setTimeout(
      () => {
        cleanup();
        reject(new Error(`2FA timeout for ${memberName}`));
      },
      Math.max(0, deadlineMs - Date.now())
    );

    signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(requestId, {
      requestId,
      telegramId,
      resolve: (code) => {
        cleanup();
        resolve(code);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      },
      method,
      memberName,
      sequence: ++nextSequence,
      timeoutHandle,
    });
  });
}

export function resetPendingForTests(): void {
  for (const req of pending.values()) {
    clearTimeout(req.timeoutHandle);
    req.reject(new Error("Reset"));
  }
  pending.clear();
  nextSequence = 0;
}
