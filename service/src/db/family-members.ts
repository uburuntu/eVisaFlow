import type { SupabaseClient } from "@supabase/supabase-js";

export interface DbFamilyMember {
  id: string;
  user_id: string;
  display_name: string;
  auth_type: string;
  encrypted_doc_number: string;
  dob_day: number;
  dob_month: number;
  dob_year: number;
  preferred_2fa_method: string;
  purpose: string;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export async function addFamilyMember(
  db: SupabaseClient,
  member: {
    user_id: string;
    display_name: string;
    auth_type: string;
    encrypted_doc_number: string;
    dob_day: number;
    dob_month: number;
    dob_year: number;
    preferred_2fa_method: string;
    purpose: string;
  },
): Promise<DbFamilyMember> {
  const { data, error } = await db
    .from("family_members")
    .insert(member)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getActiveFamilyMembers(
  db: SupabaseClient,
  userId: string,
): Promise<DbFamilyMember[]> {
  const { data, error } = await db
    .from("family_members")
    .select()
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function getFamilyMemberById(
  db: SupabaseClient,
  memberId: string,
  userId: string,
): Promise<DbFamilyMember | null> {
  const { data, error } = await db
    .from("family_members")
    .select()
    .eq("id", memberId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function deactivateFamilyMember(
  db: SupabaseClient,
  memberId: string,
  userId: string,
): Promise<void> {
  const { error } = await db
    .from("family_members")
    .update({ is_active: false })
    .eq("id", memberId)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function countActiveFamilyMembers(
  db: SupabaseClient,
  userId: string,
): Promise<number> {
  const { count, error } = await db
    .from("family_members")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("is_active", true);
  if (error) throw error;
  return count ?? 0;
}
