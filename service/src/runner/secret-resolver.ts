import type { Applicant, IdentityDocument, Purpose, TwoFactorMethod } from "evisa-flow";
import { decrypt } from "../crypto/encryption.js";
import type { Db } from "../db/client.js";
import { type DbFamilyMember, getFamilyMemberById } from "../db/family-members.js";
import type { Logger } from "../utils/logger.js";
import type { RunApplicantInput } from "./run-types.js";

/** Browser-ready, plaintext run inputs. Held only transiently in worker RAM. */
export interface ResolvedSecret {
  applicant: Applicant;
  purpose: Purpose;
  twoFactorMethod?: TwoFactorMethod;
  memberName: string;
}

export interface SecretResolverDeps {
  db?: Db;
  serverKeyHex?: string;
  log?: Logger;
  /** Injectable for tests; defaults to the real DB accessor. */
  getMember?: typeof getFamilyMemberById;
  /** Injectable for tests; defaults to the AES-GCM decrypt. */
  decryptDocNumber?: typeof decrypt;
}

const VALID_DOC_TYPES: ReadonlySet<IdentityDocument["type"]> = new Set([
  "passport",
  "nationalId",
  "brc",
  "ukvi",
]);

function toIdentityDocument(authType: string, docNumber: string): IdentityDocument {
  if (!VALID_DOC_TYPES.has(authType as IdentityDocument["type"])) {
    throw new Error(`Unknown auth type: ${authType}`);
  }
  return { type: authType as IdentityDocument["type"], number: docNumber };
}

function memberApplicant(member: DbFamilyMember, docNumber: string): Applicant {
  return {
    identityDocument: toIdentityDocument(member.auth_type, docNumber),
    dateOfBirth: `${String(member.dob_year).padStart(4, "0")}-${String(
      member.dob_month
    ).padStart(2, "0")}-${String(member.dob_day).padStart(2, "0")}`,
  };
}

/**
 * Materializes the browser-ready plaintext applicant for a run.
 *
 * - **server custody** (`memberRef`): loads the member and AES-decrypts the
 *   stored document number with the server key (today's `buildApplicant`,
 *   relocated here). The DB and key are required.
 * - **client custody** (`inline`): returns the inline plaintext applicant
 *   unchanged. Nothing is loaded, persisted, or logged about the secret — the
 *   server never has key material for client-custody data.
 *
 * The returned plaintext must live only in a local const inside the worker for
 * the duration of the run; callers must never persist or log it.
 */
async function resolve(
  input: RunApplicantInput,
  deps: SecretResolverDeps
): Promise<ResolvedSecret> {
  if (input.kind === "inline") {
    // Client custody: pure passthrough. Do NOT touch the DB and do NOT log any
    // applicant field — the document number and DOB stay confined to the
    // returned object and the calling worker's local scope.
    deps.log?.debug({ custody: "client" }, "Resolved inline applicant");
    return {
      applicant: input.applicant,
      purpose: input.purpose,
      twoFactorMethod: input.twoFactorMethod,
      memberName: input.memberName,
    };
  }

  // Server custody: decrypt the stored member record.
  if (!deps.db) {
    throw new Error("SecretResolver: db is required for server custody");
  }
  if (!deps.serverKeyHex) {
    throw new Error("SecretResolver: serverKeyHex is required for server custody");
  }

  const getMember = deps.getMember ?? getFamilyMemberById;
  const decryptDocNumber = deps.decryptDocNumber ?? decrypt;

  const member = await getMember(deps.db, input.familyMemberId, input.userId);
  if (!member) {
    throw new Error(`Family member not found: ${input.familyMemberId}`);
  }

  const docNumber = decryptDocNumber(member.encrypted_doc_number, deps.serverKeyHex);
  // Log only non-secret structure (ids + doc type), never the number or DOB.
  deps.log?.debug(
    { custody: "server", familyMemberId: member.id, docType: member.auth_type },
    "Resolved member applicant"
  );

  return {
    applicant: memberApplicant(member, docNumber),
    purpose: member.purpose as Purpose,
    twoFactorMethod: member.preferred_2fa_method as TwoFactorMethod,
    memberName: member.display_name,
  };
}

export const SecretResolver = { resolve };
