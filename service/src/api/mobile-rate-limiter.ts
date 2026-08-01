interface Bucket {
  count: number;
  resetsAt: number;
}

export class MobileRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly maxBuckets = 10_000) {}

  consume(
    key: string,
    limit: number,
    windowMs: number,
    nowMs = Date.now()
  ): number | null {
    const existing = this.buckets.get(key);
    const bucket =
      existing && existing.resetsAt > nowMs
        ? existing
        : { count: 0, resetsAt: nowMs + windowMs };
    bucket.count += 1;
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    this.trim(nowMs);
    return bucket.count > limit
      ? Math.max(1, Math.ceil((bucket.resetsAt - nowMs) / 1_000))
      : null;
  }

  private trim(nowMs: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetsAt <= nowMs) this.buckets.delete(key);
    }
    while (this.buckets.size > this.maxBuckets) {
      const oldest = this.buckets.keys().next().value;
      if (!oldest) return;
      this.buckets.delete(oldest);
    }
  }
}
