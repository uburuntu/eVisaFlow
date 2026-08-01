import type { SupabaseClient } from "@supabase/supabase-js";

export interface MobileAuth {
  getUserId(accessToken: string): Promise<string | null>;
}

export class SupabaseMobileAuth implements MobileAuth {
  constructor(private readonly db: SupabaseClient) {}

  async getUserId(accessToken: string): Promise<string | null> {
    const { data, error } = await this.db.auth.getUser(accessToken);
    if (error || !data.user) {
      return null;
    }
    return data.user.id;
  }
}
