import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface MobileAuth {
  getUserId(accessToken: string): Promise<string | null>;
}

export class SupabaseMobileAuth implements MobileAuth {
  private readonly cache = new Map<
    string,
    { userId: string | null; expiresAt: number }
  >();
  private readonly pending = new Map<string, Promise<string | null>>();

  constructor(
    private readonly db: SupabaseClient,
    private readonly options: {
      validTtlMs?: number;
      invalidTtlMs?: number;
      maxEntries?: number;
    } = {}
  ) {}

  async getUserId(accessToken: string): Promise<string | null> {
    const key = createHash("sha256").update(accessToken).digest("hex");
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.userId;
    if (cached) this.cache.delete(key);

    const existing = this.pending.get(key);
    if (existing) return existing;

    const verification = this.verify(accessToken)
      .then((userId) => {
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

  private async verify(accessToken: string): Promise<string | null> {
    const { data, error } = await this.db.auth.getUser(accessToken);
    return error || !data.user ? null : data.user.id;
  }

  private trimCache(): void {
    const maxEntries = this.options.maxEntries ?? 1_000;
    while (this.cache.size > maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (!oldest) return;
      this.cache.delete(oldest);
    }
  }
}
