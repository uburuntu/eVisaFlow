import { z } from "zod";
import { makeRequireUser } from "../../auth/session.js";
import type { Db } from "../../db/client.js";
import { getVault, upsertVault } from "../../db/user-vault.js";
import type { Logger } from "../../utils/logger.js";
import type { WebFastifyInstance } from "../server.js";

/**
 * Vault routes: store and fetch the client-held-key crypto material.
 *
 * SECURITY: every field here is OPAQUE to the server. The X25519 public key, the
 * passphrase-wrapped private key, the Argon2id `kdfSalt`/`kdfParams`, and the
 * optional recovery-kit-wrapped private key are all generated and (un)wrapped in
 * the browser. The server only persists and returns these blobs — it never holds
 * the passphrase or the unwrapped private key. POST upserts the 1:1 vault (used at
 * creation and on re-wrap/rotation); GET returns the wrapped blobs so the client
 * can unwrap them locally.
 */

export interface VaultRoutesDeps {
  db: Db;
  log: Logger;
}

// Opaque crypto blobs travel as base64 strings over JSON. We bound each to a
// sane size: an X25519 public key is 32 bytes, wrapped keys are tiny
// (secretbox(32-byte key) ≈ 72 bytes), salts are 16–32 bytes. 4 KiB is generous
// for any libsodium output while rejecting accidental large bodies; the server
// never inspects the contents.
const base64Blob = z.string().min(1).max(4096);

const vaultBodySchema = z.object({
  publicKey: base64Blob,
  wrappedPrivateKey: base64Blob,
  kdfSalt: base64Blob,
  // KDF parameters (e.g. Argon2id opslimit/memlimit/alg) stored verbatim as JSON
  // for the client to reproduce the derivation. Opaque to the server.
  kdfParams: z.record(z.string(), z.unknown()),
  // Optional second wrapped copy of the private key, unlockable by the recovery
  // kit. Omitted when the user declines a recovery kit.
  recoveryWrappedKey: base64Blob.optional(),
});

/** Public shape returned by GET /api/vault (base64 blobs for client unwrap). */
interface VaultResponse {
  publicKey: string;
  wrappedPrivateKey: string;
  kdfSalt: string;
  kdfParams: unknown;
  recoveryWrappedKey: string | null;
}

export function registerVaultRoutes(
  app: WebFastifyInstance,
  deps: VaultRoutesDeps
): void {
  const { db } = deps;
  const requireUser = makeRequireUser(db);

  /**
   * Create or replace the current user's vault. Stores the opaque blobs as-is
   * (base64 → bytes). Idempotent per user (1:1 upsert), so it also handles
   * passphrase change / recovery-kit rotation. The server never decodes or
   * validates the crypto contents beyond shape/size.
   */
  app.post("/api/vault", { preHandler: requireUser }, async (request, reply) => {
    // requireUser guarantees request.user; assert for the type narrowing.
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthorized" });

    const parsed = vaultBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_vault" });
    }
    const { publicKey, wrappedPrivateKey, kdfSalt, kdfParams, recoveryWrappedKey } =
      parsed.data;

    await upsertVault(db, {
      user_id: user.id,
      public_key: Buffer.from(publicKey, "base64"),
      wrapped_private_key: Buffer.from(wrappedPrivateKey, "base64"),
      kdf_salt: Buffer.from(kdfSalt, "base64"),
      kdf_params: kdfParams,
      recovery_wrapped_key: recoveryWrappedKey
        ? Buffer.from(recoveryWrappedKey, "base64")
        : null,
    });

    return reply.code(204).send();
  });

  /**
   * Fetch the current user's wrapped vault blobs (base64) for client-side unwrap,
   * or 404 when they have not created a vault yet.
   */
  app.get("/api/vault", { preHandler: requireUser }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthorized" });

    const vault = await getVault(db, user.id);
    if (!vault) {
      return reply.code(404).send({ error: "no_vault" });
    }
    const body: VaultResponse = {
      publicKey: vault.public_key.toString("base64"),
      wrappedPrivateKey: vault.wrapped_private_key.toString("base64"),
      kdfSalt: vault.kdf_salt.toString("base64"),
      kdfParams: vault.kdf_params,
      recoveryWrappedKey: vault.recovery_wrapped_key
        ? vault.recovery_wrapped_key.toString("base64")
        : null,
    };
    return reply.code(200).send(body);
  });
}
