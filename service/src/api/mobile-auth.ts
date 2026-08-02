import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface MobileAuth {
  getUserId(accessToken: string): Promise<string | null>;
  invalidateAccessToken(accessToken: string): void;
}

export class SupabaseMobileAuth implements MobileAuth {
  private readonly cache = new Map<
    string,
    { userId: string | null; expiresAt: number }
  >();
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly invalidated = new Map<string, number>();

  constructor(
    private readonly db: SupabaseClient,
    private readonly options: {
      validTtlMs?: number;
      invalidTtlMs?: number;
      invalidatedTtlMs?: number;
      maxEntries?: number;
    } = {}
  ) {}

  async getUserId(accessToken: string): Promise<string | null> {
    const key = createHash("sha256").update(accessToken).digest("hex");
    if (this.isInvalidated(key)) return null;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.userId;
    if (cached) this.cache.delete(key);

    const existing = this.pending.get(key);
    if (existing) return existing;

    const verification = this.verify(accessToken)
      .then((userId) => {
        if (this.isInvalidated(key)) return null;
        this.cache.set(key, {
          userId,
          expiresAt:
            Date.now() +
            (userId
              ? (this.options.validTtlMs ?? 60_000)
              : (this.options.invalidTtlMs ?? 5_000)),
        });
        this.trimCache();
        return userId;
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, verification);
    return verification;
  }

  invalidateAccessToken(accessToken: string): void {
    const key = createHash("sha256").update(accessToken).digest("hex");
    this.cache.delete(key);
    this.invalidated.set(key, Date.now() + (this.options.invalidatedTtlMs ?? 5 * 60_000));
    this.trimMap(this.invalidated);
  }

  private async verify(accessToken: string): Promise<string | null> {
    const { data, error } = await this.db.auth.getUser(accessToken);
    return error || !data.user ? null : data.user.id;
  }

  private trimCache(): void {
    this.trimMap(this.cache);
  }

  private isInvalidated(key: string): boolean {
    const expiresAt = this.invalidated.get(key);
    if (!expiresAt) return false;
    if (expiresAt > Date.now()) return true;
    this.invalidated.delete(key);
    return false;
  }

  private trimMap(map: Map<string, unknown>): void {
    const maxEntries = this.options.maxEntries ?? 1_000;
    while (map.size > maxEntries) {
      const oldest = map.keys().next().value;
      if (!oldest) return;
      map.delete(oldest);
    }
  }
}
