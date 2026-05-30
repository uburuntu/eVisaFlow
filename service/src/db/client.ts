import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Stable database handle type used across the service. Currently an alias of
 * the Supabase client; a later phase swaps the underlying implementation to a
 * portable Postgres client without changing this seam or any `db/*` signatures.
 */
export type Db = SupabaseClient;

let client: SupabaseClient | undefined;

export function getSupabase(url: string, serviceRoleKey: string): SupabaseClient {
  if (client) return client;
  client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return client;
}
