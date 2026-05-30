/**
 * The member secret: the only place a member's identity data exists in cleartext,
 * and only ever IN THE BROWSER.
 *
 * A member's applicant details (document type/number, date of birth, 2FA method,
 * run purpose) are serialised to JSON, then sealed to the user's OWN X25519
 * public key with `crypto_box_seal` ({@link sealMemberSecret}). The server stores
 * only that opaque blob (`encryptedSecret`); it never sees the plaintext. Before a
 * run, the browser fetches the blob and opens it ({@link openMemberSecret}) with
 * the unlocked vault key pair, then derives the per-run inline applicant.
 *
 * Versioned (`v: 1`) so the shape can evolve without misreading old blobs.
 */

import {
  type BoxKeyPair,
  bytesToString,
  fromBase64,
  openForSelf,
  sealForSelf,
  stringToBytes,
  toBase64,
} from "../runtime/sodium.js";
import type { InlineApplicant } from "./api-client.js";

/** UK identity document types accepted by the eVisa flow. */
export type DocumentType = "passport" | "nationalId" | "brc" | "ukvi";

/** Run purposes the share code can be created for. */
export type Purpose = "right_to_work" | "right_to_rent" | "immigration_status_other";

/** Two-factor delivery channel chosen for the member. */
export type TwoFactorMethod = "sms" | "email";

/**
 * The plaintext member secret, as sealed in the browser. `v` guards the layout.
 * `dateOfBirth` is stored as a `{day,month,year}` triple — unambiguous across
 * locales and exactly what the run route accepts.
 */
export interface MemberSecret {
  v: 1;
  documentType: DocumentType;
  documentNumber: string;
  dateOfBirth: { day: number; month: number; year: number };
  twoFactorMethod: TwoFactorMethod;
  purpose: Purpose;
}

/**
 * Seals a {@link MemberSecret} to the user's own public key and returns the
 * base64 blob to store as `encryptedSecret`. Anonymous `crypto_box_seal`, so it
 * needs only the public key; only the matching private key (unlocked in the
 * vault) can open it later. Requires the libsodium runtime to be ready.
 */
export function sealMemberSecret(secret: MemberSecret, publicKey: Uint8Array): string {
  const json = JSON.stringify(secret);
  const sealed = sealForSelf(stringToBytes(json), publicKey);
  return toBase64(sealed);
}

/**
 * Opens a base64 `encryptedSecret` with the vault key pair and parses it back to
 * a {@link MemberSecret}. Throws if the blob is tampered/foreign (the seal fails
 * to authenticate) or the JSON/version is not what we wrote. Requires libsodium
 * ready and an UNLOCKED vault.
 */
export function openMemberSecret(
  encryptedSecret: string,
  keyPair: BoxKeyPair
): MemberSecret {
  const sealed = fromBase64(encryptedSecret);
  const opened = openForSelf(sealed, keyPair.publicKey, keyPair.privateKey);
  const parsed = JSON.parse(bytesToString(opened)) as Partial<MemberSecret>;
  if (parsed?.v !== 1 || !parsed.documentType || !parsed.dateOfBirth) {
    throw new Error("member secret has an unexpected shape");
  }
  return parsed as MemberSecret;
}

/** Maps an opened {@link MemberSecret} to the inline applicant a run POST needs. */
export function applicantFromSecret(secret: MemberSecret): InlineApplicant {
  return {
    identityDocument: { type: secret.documentType, number: secret.documentNumber },
    dateOfBirth: secret.dateOfBirth,
  };
}
