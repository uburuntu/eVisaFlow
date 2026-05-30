import { and, asc, count, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { familyMembers } from "./schema.js";

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

type FamilyMemberRow = typeof familyMembers.$inferSelect;

function toDbFamilyMember(row: FamilyMemberRow): DbFamilyMember {
  return {
    id: row.id,
    user_id: row.userId,
    display_name: row.displayName,
    auth_type: row.authType,
    encrypted_doc_number: row.encryptedDocNumber,
    dob_day: row.dobDay,
    dob_month: row.dobMonth,
    dob_year: row.dobYear,
    preferred_2fa_method: row.preferred2faMethod,
    purpose: row.purpose,
    is_active: row.isActive,
    sort_order: row.sortOrder,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export async function addFamilyMember(
  db: Db,
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
  }
): Promise<DbFamilyMember> {
  // The max-6-active limit is enforced by the `trg_max_family_members` trigger;
  // a violation surfaces as a thrown pg error, preserving prior behaviour.
  const [row] = await db
    .insert(familyMembers)
    .values({
      userId: member.user_id,
      displayName: member.display_name,
      authType: member.auth_type,
      encryptedDocNumber: member.encrypted_doc_number,
      dobDay: member.dob_day,
      dobMonth: member.dob_month,
      dobYear: member.dob_year,
      preferred2faMethod: member.preferred_2fa_method,
      purpose: member.purpose,
    })
    .returning();
  return toDbFamilyMember(row);
}

export async function getActiveFamilyMembers(
  db: Db,
  userId: string
): Promise<DbFamilyMember[]> {
  const rows = await db
    .select()
    .from(familyMembers)
    .where(and(eq(familyMembers.userId, userId), eq(familyMembers.isActive, true)))
    .orderBy(asc(familyMembers.sortOrder));
  return rows.map(toDbFamilyMember);
}

export async function getFamilyMemberById(
  db: Db,
  memberId: string,
  userId: string
): Promise<DbFamilyMember | null> {
  const [row] = await db
    .select()
    .from(familyMembers)
    .where(and(eq(familyMembers.id, memberId), eq(familyMembers.userId, userId)))
    .limit(1);
  return row ? toDbFamilyMember(row) : null;
}

export async function deactivateFamilyMember(
  db: Db,
  memberId: string,
  userId: string
): Promise<void> {
  await db
    .update(familyMembers)
    .set({ isActive: false })
    .where(and(eq(familyMembers.id, memberId), eq(familyMembers.userId, userId)));
}

export async function countActiveFamilyMembers(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(familyMembers)
    .where(and(eq(familyMembers.userId, userId), eq(familyMembers.isActive, true)));
  return row?.value ?? 0;
}
