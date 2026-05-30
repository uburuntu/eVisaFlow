import type { RunCustody, SealedBlob } from "../runner/run-types.js";
import { decrypt, encrypt } from "./encryption.js";
import { sealToPublicKey, stringToBytes } from "./seal.js";

export type { RunCustody } from "../runner/run-types.js";

/** Context a provider may need to seal a single value. */
export interface SealContext {
  /**
   * The recipient's X25519 public key. Required for client custody (outputs are
   * sealed to it via `crypto_box_seal`); ignored by server custody.
   */
  recipientPublicKey?: Uint8Array;
}

/**
 * Pluggable output protection for a run, selected by its {@link RunCustody}.
 *
 * The engine calls the same methods regardless of custody; the provider decides
 * how outputs are protected before they leave the worker:
 *
 * - **server** (the trusted bot): AES-GCM with the server key. The bot is
 *   trusted to receive plaintext, so it can also {@link openForDelivery}.
 * - **client** (the web app, E2EE): anonymous `crypto_box_seal` to the
 *   recipient's public key. The server holds no private key, so there is
 *   deliberately no `openForDelivery` — only the client can open the result.
 */
export interface CustodyProvider {
  readonly custody: RunCustody;
  /** Seals a share code into a {@link SealedBlob}. */
  sealShareCode(plain: string, ctx: SealContext): SealedBlob;
  /** Seals artifact bytes into a {@link SealedBlob}. */
  sealArtifact(bytes: Uint8Array, ctx: SealContext): SealedBlob;
  /**
   * Recovers plaintext bytes from a blob this provider produced. Present ONLY
   * for trusted server custody; absent for client custody by design.
   */
  openForDelivery?(blob: SealedBlob): Uint8Array;
}

/**
 * Server custody: AES-GCM with the server key, wrapping {@link encrypt} /
 * {@link decrypt} from `encryption.ts`. Matches today's trusted-bot behavior —
 * the share code is encrypted to a `cipher` string, while artifact bytes are
 * carried raw (the bot is trusted to receive them) and simply tagged `aesgcm`.
 */
export function serverCustody(serverKeyHex: string): CustodyProvider {
  return {
    custody: "server",

    sealShareCode(plain: string): SealedBlob {
      return { alg: "aesgcm", cipher: encrypt(plain, serverKeyHex) };
    },

    // Artifacts keep their raw bytes for the trusted bot, unchanged from the
    // existing engine path. We do not re-encrypt them here.
    sealArtifact(bytes: Uint8Array): SealedBlob {
      return { alg: "aesgcm", bytes };
    },

    openForDelivery(blob: SealedBlob): Uint8Array {
      // Share code: a `cipher` string → AES-decrypt back to UTF-8 bytes.
      if (blob.cipher !== undefined) {
        return stringToBytes(decrypt(blob.cipher, serverKeyHex));
      }
      // Artifact: raw bytes were carried as-is for the trusted bot.
      if (blob.bytes !== undefined) {
        return blob.bytes;
      }
      throw new Error("serverCustody.openForDelivery: blob has no cipher or bytes");
    },
  };
}

/**
 * Client custody (E2EE): seals every output to the recipient's public key with
 * anonymous `crypto_box_seal`. No passphrase or sender secret is needed, so the
 * worker can seal even for scheduled/async delivery. There is deliberately NO
 * `openForDelivery` — the server has no private key for client data, so only the
 * client can open these blobs. Requires `seal.ready()` to have resolved first.
 */
export function clientCustody(): CustodyProvider {
  function seal(bytes: Uint8Array, ctx: SealContext): SealedBlob {
    if (!ctx.recipientPublicKey) {
      throw new Error("clientCustody: recipientPublicKey is required to seal outputs");
    }
    return { alg: "box_seal", bytes: sealToPublicKey(bytes, ctx.recipientPublicKey) };
  }

  return {
    custody: "client",
    sealShareCode(plain: string, ctx: SealContext): SealedBlob {
      return seal(stringToBytes(plain), ctx);
    },
    sealArtifact(bytes: Uint8Array, ctx: SealContext): SealedBlob {
      return seal(bytes, ctx);
    },
    // openForDelivery is intentionally omitted: the server cannot open client
    // ciphertext, and must not appear able to.
  };
}
