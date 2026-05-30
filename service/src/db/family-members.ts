import { and, asc, count, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { familyMembers } from "./schema.js";

export interface DbFamilyMember {
  id: string;
  user_id: string;
  display_name: string;
  /** 'server' (trusted bot, AES doc number) or 'client' (web E2EE, sealed secret). */
  custody: string;
  // The next group is non-null only for server-custody rows; NULL for client
  // rows, whose data lives in `encrypted_secret` instead (migration 005).
  auth_type: string | null;
  encrypted_doc_number: string | null;
  dob_day: number | null;
  dob_month: number | null;
  dob_year: number | null;
  preferred_2fa_method: string | null;
  purpose: string | null;
  /** Opaque blob sealed to the user's public key, for client custody (005). */
  encrypted_secret: Buffer | null;
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
    custody: row.custody,
    auth_type: row.authType,
    encrypted_doc_number: row.encryptedDocNumber,
    dob_day: row.dobDay,
    dob_month: row.dobMonth,
    dob_year: row.dobYear,
    preferred_2fa_method: row.preferred2faMethod,
    purpose: row.purpose,
    encrypted_secret: row.encryptedSecret,
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

/**
 * Inserts a CLIENT-custody member (the E2EE web app path). The server stores ONLY
 * the opaque {@link encrypted_secret} blob — sealed to the user's public key
 * (`crypto_box_seal`) and holding the entire applicant ({docType, docNumber, dob,
 * 2fa, purpose}). The server never sees that plaintext and holds no key to open
 * it, so the cleartext-ish columns (`auth_type`, `encrypted_doc_number`, `dob_*`,
 * `preferred_2fa_method`, `purpose`) are intentionally left NULL; the
 * `family_members_custody_secret_check` constraint requires `encrypted_secret` to
 * be present for `custody='client'` rows.
 *
 * The max-6-active limit (`trg_max_family_members`) is enforced by the DB trigger;
 * a violation surfaces as a thrown pg error, identical to {@link addFamilyMember}.
 */
export async function addClientMember(
  db: Db,
  member: {
    user_id: string;
    display_name: string;
    encrypted_secret: Buffer;
  }
): Promise<DbFamilyMember> {
  const [row] = await db
    .insert(familyMembers)
    .values({
      userId: member.user_id,
      displayName: member.display_name,
      custody: "client",
      encryptedSecret: member.encrypted_secret,
      // All cleartext-ish columns stay NULL for client custody (data lives sealed
      // in encrypted_secret). preferred2faMethod/purpose carry table-level
      // defaults, so set them explicit-null to keep the row free of any applicant
      // hints the server should not retain.
      preferred2faMethod: null,
      purpose: null,
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
