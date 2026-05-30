import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { userVault } from "./schema.js";

/**
 * Drizzle accessors for the `user_vault` table (migration 004): the
 * client-held-key crypto material, 1:1 with a user and optional.
 *
 * SECURITY: every blob here is OPAQUE to the server. It stores the X25519 public
 * key, the passphrase-wrapped private key, the Argon2id `kdf_salt`/`kdf_params`,
 * and an optional recovery-kit-wrapped copy of the private key — and it never
 * decrypts any of them (it holds no passphrase). These accessors only persist and
 * return bytes; all key derivation/unwrapping happens client-side in the browser.
 */

export interface DbUserVault {
  user_id: string;
  public_key: Buffer;
  wrapped_private_key: Buffer;
  kdf_salt: Buffer;
  kdf_params: unknown;
  recovery_wrapped_key: Buffer | null;
  created_at: string;
  updated_at: string;
}

type UserVaultRow = typeof userVault.$inferSelect;

function toDbUserVault(row: UserVaultRow): DbUserVault {
  return {
    user_id: row.userId,
    public_key: row.publicKey,
    wrapped_private_key: row.wrappedPrivateKey,
    kdf_salt: row.kdfSalt,
    kdf_params: row.kdfParams,
    recovery_wrapped_key: row.recoveryWrappedKey,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/**
 * Inserts or replaces a user's vault (1:1, keyed by `user_id`). Used both at
 * vault creation and when the user re-wraps their key (e.g. passphrase change or
 * adding/rotating the recovery kit). `kdf_params` is stored verbatim as JSON. On
 * conflict every blob is overwritten; `updated_at` is refreshed by the DB
 * trigger.
 */
export async function upsertVault(
  db: Db,
  vault: {
    user_id: string;
    public_key: Buffer;
    wrapped_private_key: Buffer;
    kdf_salt: Buffer;
    kdf_params: unknown;
    recovery_wrapped_key?: Buffer | null;
  }
): Promise<DbUserVault> {
  const values = {
    userId: vault.user_id,
    publicKey: vault.public_key,
    wrappedPrivateKey: vault.wrapped_private_key,
    kdfSalt: vault.kdf_salt,
    kdfParams: vault.kdf_params,
    recoveryWrappedKey: vault.recovery_wrapped_key ?? null,
  };
  const [row] = await db
    .insert(userVault)
    .values(values)
    .onConflictDoUpdate({
      target: userVault.userId,
      set: {
        publicKey: values.publicKey,
        wrappedPrivateKey: values.wrappedPrivateKey,
        kdfSalt: values.kdfSalt,
        kdfParams: values.kdfParams,
        recoveryWrappedKey: values.recoveryWrappedKey,
      },
    })
    .returning();
  return toDbUserVault(row);
}

/** Fetches a user's vault by user id, or null when they have not created one. */
export async function getVault(db: Db, userId: string): Promise<DbUserVault | null> {
  const [row] = await db
    .select()
    .from(userVault)
    .where(eq(userVault.userId, userId))
    .limit(1);
  return row ? toDbUserVault(row) : null;
}
