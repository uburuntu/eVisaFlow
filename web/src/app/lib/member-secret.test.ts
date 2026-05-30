import { beforeAll, describe, expect, it } from "vitest";
import { generateKeypair, ready } from "../runtime/sodium.js";
import {
  applicantFromSecret,
  type MemberSecret,
  openMemberSecret,
  sealMemberSecret,
} from "./member-secret.js";

/**
 * Round-trip tests for the member secret: the only cleartext member data, sealed
 * to the user's own public key and opened with their private key. These exercise
 * real libsodium (like the vault suite) to prove the seal/open contract and that
 * the derived inline applicant matches what the run route expects.
 */
beforeAll(async () => {
  await ready();
});

const SAMPLE: MemberSecret = {
  v: 1,
  documentType: "passport",
  documentNumber: "123456789",
  dateOfBirth: { day: 4, month: 7, year: 1990 },
  twoFactorMethod: "sms",
  purpose: "right_to_work",
};

describe("sealMemberSecret / openMemberSecret", () => {
  it("round-trips a secret sealed to the owner's key", () => {
    const keyPair = generateKeypair();
    const blob = sealMemberSecret(SAMPLE, keyPair.publicKey);
    expect(typeof blob).toBe("string");

    const opened = openMemberSecret(blob, keyPair);
    expect(opened).toEqual(SAMPLE);
  });

  it("cannot be opened with a different key pair", () => {
    const owner = generateKeypair();
    const stranger = generateKeypair();
    const blob = sealMemberSecret(SAMPLE, owner.publicKey);
    expect(() => openMemberSecret(blob, stranger)).toThrow();
  });

  it("rejects a secret with an unexpected version/shape", () => {
    const keyPair = generateKeypair();
    // Seal a bogus payload directly via the same primitive to simulate a foreign blob.
    const bad = sealMemberSecret({ ...SAMPLE, v: 2 as unknown as 1 }, keyPair.publicKey);
    expect(() => openMemberSecret(bad, keyPair)).toThrow();
  });
});

describe("applicantFromSecret", () => {
  it("maps a secret to the inline applicant the run route accepts", () => {
    expect(applicantFromSecret(SAMPLE)).toEqual({
      identityDocument: { type: "passport", number: "123456789" },
      dateOfBirth: { day: 4, month: 7, year: 1990 },
    });
  });
});
