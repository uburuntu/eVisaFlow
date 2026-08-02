import type { TwoFactorMethod } from "evisa-flow";

interface PendingChallenge {
  runId: string;
  userId: string;
  method: TwoFactorMethod;
  deadlineMs: number;
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort: () => void;
}

const pending = new Map<string, PendingChallenge>();

export function requestMobileChallenge(options: {
  runId: string;
  userId: string;
  method: TwoFactorMethod;
  deadlineMs: number;
  signal?: AbortSignal;
}): Promise<string> {
  cancelMobileChallenge(options.runId, "Superseded by a new challenge");

  return new Promise<string>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Security code challenge was cancelled"));
      return;
    }

    let challenge!: PendingChallenge;
    const onAbort = () => {
      cleanup(challenge);
      reject(new Error("Security code challenge was cancelled"));
    };
    const timeout = setTimeout(
      () => {
        cleanup(challenge);
        reject(new Error("Security code challenge expired"));
      },
      Math.max(0, options.deadlineMs - Date.now())
    );

    challenge = {
      ...options,
      resolve: (code) => {
        cleanup(challenge);
        resolve(code);
      },
      reject: (error) => {
        cleanup(challenge);
        reject(error);
      },
      timeout,
      onAbort,
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(options.runId, challenge);
  });
}

export function submitMobileChallenge(options: {
  runId: string;
  userId: string;
  code: string;
}): boolean {
  const challenge = pending.get(options.runId);
  if (
    !challenge ||
    challenge.userId !== options.userId ||
    Date.now() >= challenge.deadlineMs
  ) {
    return false;
  }
  challenge.resolve(options.code);
  return true;
}

export function cancelMobileChallenge(runId: string, reason: string): boolean {
  const challenge = pending.get(runId);
  if (!challenge) {
    return false;
  }
  challenge.reject(new Error(reason));
  return true;
}

function cleanup(challenge: PendingChallenge): void {
  clearTimeout(challenge.timeout);
  pending.delete(challenge.runId);
  challenge.signal?.removeEventListener("abort", challenge.onAbort);
}

export function resetMobileChallengesForTests(): void {
  for (const challenge of Array.from(pending.values())) {
    challenge.reject(new Error("Reset"));
  }
}
