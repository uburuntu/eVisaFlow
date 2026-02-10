import type { TwoFactorMethod } from "evisa-flow";

interface PendingRequest {
  resolve: (code: string) => void;
  reject: (err: Error) => void;
  method: TwoFactorMethod;
  memberName: string;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

const pending = new Map<number, PendingRequest>();

export function hasPending(telegramId: number): boolean {
  return pending.has(telegramId);
}

export function submitCode(telegramId: number, code: string): boolean {
  const req = pending.get(telegramId);
  if (!req) return false;
  clearTimeout(req.timeoutHandle);
  pending.delete(telegramId);
  req.resolve(code);
  return true;
}

export function requestCode(
  telegramId: number,
  method: TwoFactorMethod,
  memberName: string,
  deadlineMs: number,
): Promise<string> {
  // Supersede any existing request
  const existing = pending.get(telegramId);
  if (existing) {
    clearTimeout(existing.timeoutHandle);
    existing.reject(new Error("Superseded by new request"));
    pending.delete(telegramId);
  }

  return new Promise<string>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      pending.delete(telegramId);
      reject(new Error(`2FA timeout for ${memberName}`));
    }, Math.max(0, deadlineMs - Date.now()));

    pending.set(telegramId, {
      resolve,
      reject,
      method,
      memberName,
      timeoutHandle,
    });
  });
}
