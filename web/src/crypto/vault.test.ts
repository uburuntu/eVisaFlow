import { beforeAll, describe, expect, it } from "vitest";
import {
  bytesToString,
  createRecoveryKit,
  createVault,
  defaultKdfParams,
  deriveWrapKey,
  fromBase64,
  generateKdfSalt,
  generateKeypair,
  openForSelf,
  openSealedArtifact,
  ready,
  recoverVault,
  sealForSelf,
  stringToBytes,
  toBase64,
  unlockVault,
  unpackArtifactEnvelope,
  unwrapPrivateKey,
  unwrapWithRecoveryCode,
  wrapPrivateKey,
} from "./vault.js";

/**
 * In-browser vault crypto tests. These pin the BYTE-level compatibility with the
 * server (`service/src/crypto/seal.ts`) that the whole client-custody E2EE model
 * depends on: a run's outputs are sealed by the worker with `crypto_box_seal` to
 * the vault public key and packed in the "EVA1" envelope, and the browser must
 * open + unpack them with no server involvement.
 *
 * The vault uses the `libsodium-wrappers-sumo` build (Argon2id `crypto_pwhash` is
 * sumo-only); `vitest.config.ts` aliases it to its CommonJS entry so its WASM
 * initializes correctly under Node (the ESM entry mis-resolves under pnpm). Every
 * test awaits `ready()` first.
 */
beforeAll(async () => {
  await ready();
});

describe("keypair seal/open", () => {
  it("round-trips plaintext sealed to the public key", async () => {
    const { publicKey, privateKey } = generateKeypair();
    expect(publicKey.length).toBe(32);
    expect(privateKey.length).toBe(32);

    const plaintext = stringToBytes("share-code: ABCD-1234");
    const sealed = sealForSelf(plaintext, publicKey);

    // crypto_box_seal adds a 48-byte overhead (ephemeral pk + MAC), same as the
    // server's seal.test.js asserts.
    expect(sealed.length).toBe(plaintext.length + 48);
    expect(Array.from(sealed)).not.toEqual(Array.from(plaintext));

    const opened = openForSelf(sealed, publicKey, privateKey);
    expect(bytesToString(opened)).toBe("share-code: ABCD-1234");
  });

  it("rejects a tampered ciphertext and a stranger's keys", async () => {
    const { publicKey, privateKey } = generateKeypair();
    const sealed = sealForSelf(stringToBytes("top secret"), publicKey);

    const tampered = Uint8Array.from(sealed);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => openForSelf(tampered, publicKey, privateKey)).toThrow();

    const stranger = generateKeypair();
    expect(() => openForSelf(sealed, stranger.publicKey, stranger.privateKey)).toThrow();
  });

  it("rejects a malformed public key before sealing", () => {
    expect(() => sealForSelf(stringToBytes("x"), new Uint8Array(0))).toThrow(/32 bytes/);
    expect(() => sealForSelf(stringToBytes("x"), new Uint8Array(16))).toThrow(/32 bytes/);
  });
});

describe("Argon2id KDF determinism", () => {
  // Use light work factors so the suite stays fast; determinism is independent of
  // the cost parameters as long as they are held constant.
  const fastParams = () => ({
    opslimit: defaultKdfParams().opslimit, // MODERATE ops is cheap; memory is the cost.
    memlimit: 8 * 1024 * 1024, // 8 MiB — quick, still Argon2id.
    alg: defaultKdfParams().alg,
  });

  it("derives the SAME key for the same passphrase + salt + params", () => {
    const salt = generateKdfSalt();
    const params = fastParams();
    const k1 = deriveWrapKey("correct horse battery staple", salt, params);
    const k2 = deriveWrapKey("correct horse battery staple", salt, params);
    expect(k1.length).toBe(32);
    expect(Array.from(k1)).toEqual(Array.from(k2));
  });

  it("derives a DIFFERENT key for a different salt", () => {
    const params = fastParams();
    const k1 = deriveWrapKey("correct horse battery staple", generateKdfSalt(), params);
    const k2 = deriveWrapKey("correct horse battery staple", generateKdfSalt(), params);
    expect(Array.from(k1)).not.toEqual(Array.from(k2));
  });

  it("derives a DIFFERENT key for a different passphrase", () => {
    const salt = generateKdfSalt();
    const params = fastParams();
    const k1 = deriveWrapKey("passphrase A", salt, params);
    const k2 = deriveWrapKey("passphrase B", salt, params);
    expect(Array.from(k1)).not.toEqual(Array.from(k2));
  });

  it("rejects a wrong-sized salt", () => {
    expect(() => deriveWrapKey("x", new Uint8Array(8))).toThrow(/salt must be/);
  });

  it("defaultKdfParams pins Argon2id (ALG_ARGON2ID13) and MODERATE limits", () => {
    const p = defaultKdfParams();
    // ALG_ARGON2ID13 is libsodium algorithm id 2; pin it so a future default
    // change cannot silently alter stored vaults.
    expect(p.alg).toBe(2);
    expect(p.opslimit).toBeGreaterThan(0);
    expect(p.memlimit).toBeGreaterThan(0);
  });
});

describe("private-key wrap/unwrap", () => {
  it("wraps then unwraps the private key (nonce is prepended)", () => {
    const { privateKey } = generateKeypair();
    const wrapKey = deriveWrapKey("pw", generateKdfSalt(), {
      ...defaultKdfParams(),
      memlimit: 8 * 1024 * 1024,
    });

    const wrapped = wrapPrivateKey(privateKey, wrapKey);
    // 24-byte nonce + secretbox(32-byte key) = 24 + (32 + 16) = 72 bytes.
    expect(wrapped.length).toBe(72);

    const out = unwrapPrivateKey(wrapped, wrapKey);
    expect(Array.from(out)).toEqual(Array.from(privateKey));
  });

  it("fails to unwrap with the wrong key", () => {
    const { privateKey } = generateKeypair();
    const params = { ...defaultKdfParams(), memlimit: 8 * 1024 * 1024 };
    const rightKey = deriveWrapKey("right", generateKdfSalt(), params);
    const wrapped = wrapPrivateKey(privateKey, rightKey);
    const wrongKey = deriveWrapKey("wrong", generateKdfSalt(), params);
    expect(() => unwrapPrivateKey(wrapped, wrongKey)).toThrow();
  });

  it("rejects a too-short wrapped blob", () => {
    const wrapKey = deriveWrapKey("pw", generateKdfSalt(), {
      ...defaultKdfParams(),
      memlimit: 8 * 1024 * 1024,
    });
    expect(() => unwrapPrivateKey(new Uint8Array(10), wrapKey)).toThrow(/too short/);
  });
});

describe("recovery kit", () => {
  it("recovers the same private key from the recovery code", () => {
    const { privateKey } = generateKeypair();
    const kit = createRecoveryKit(privateKey);

    expect(typeof kit.recoveryCode).toBe("string");
    expect(kit.recoveryCode.length).toBeGreaterThan(20); // 256-bit, base64-encoded.

    const recovered = unwrapWithRecoveryCode(
      kit.recoveryWrappedKey,
      kit.recoveryCode,
      kit.recoverySalt,
      kit.recoveryParams
    );
    expect(Array.from(recovered)).toEqual(Array.from(privateKey));
  });

  it("rejects a wrong recovery code", () => {
    const { privateKey } = generateKeypair();
    const kit = createRecoveryKit(privateKey);
    expect(() =>
      unwrapWithRecoveryCode(
        kit.recoveryWrappedKey,
        "not-the-code",
        kit.recoverySalt,
        kit.recoveryParams
      )
    ).toThrow();
  });
});

describe("ENVELOPE-COMPAT with service/src/crypto/seal.ts", () => {
  /**
   * Builds an "EVA1" artifact envelope using the EXACT byte layout the server
   * packs (`packArtifactEnvelope`), constructed here by hand so the test is an
   * independent oracle and not just a self-round-trip:
   *
   *   [4]  magic 0x45 0x56 0x41 0x31  ("EVA1")
   *   [4]  filename byte length, big-endian uint32
   *   [n]  filename UTF-8 bytes
   *   [..] payload bytes
   */
  function packLikeServer(filename: string, payload: Uint8Array): Uint8Array {
    const nameBytes = stringToBytes(filename);
    const header = new Uint8Array(8);
    header.set([0x45, 0x56, 0x41, 0x31], 0);
    new DataView(header.buffer).setUint32(4, nameBytes.length, false); // big-endian.
    const out = new Uint8Array(header.length + nameBytes.length + payload.length);
    out.set(header, 0);
    out.set(nameBytes, header.length);
    out.set(payload, header.length + nameBytes.length);
    return out;
  }

  it("unpacks bytes laid out exactly like the server packer", () => {
    const filename = "EVISA_SMITH_JOHN_2031-03-03.pdf";
    const payload = stringToBytes("%PDF-1.7 ...binary... payload");

    const envelope = packLikeServer(filename, payload);
    const out = unpackArtifactEnvelope(envelope);
    expect(out.filename).toBe(filename);
    expect(Array.from(out.bytes)).toEqual(Array.from(payload));
  });

  it("opens a sealed server-style envelope end to end (seal → open → unpack)", () => {
    const { publicKey, privateKey } = generateKeypair();
    const filename = "EVISA_DOE_JANE_2030-12-31.pdf";
    const payload = stringToBytes("checker-html or pdf bytes, possibly with é/ÿ");

    // Worker side: pack with the server layout, then crypto_box_seal to the vault.
    const sealed = sealForSelf(packLikeServer(filename, payload), publicKey);
    // Browser side: the single call the run screen uses.
    const out = openSealedArtifact(sealed, publicKey, privateKey);

    expect(out.filename).toBe(filename);
    expect(Array.from(out.bytes)).toEqual(Array.from(payload));
  });

  it("preserves a multibyte UTF-8 filename via the big-endian length prefix", () => {
    const filename = "EVISA_ÅSTRÖM_JOSÉ_2032-01-01.pdf"; // multibyte chars.
    const payload = stringToBytes("x");
    const out = unpackArtifactEnvelope(packLikeServer(filename, payload));
    expect(out.filename).toBe(filename);
    // The length prefix counts BYTES, not code points.
    expect(stringToBytes(filename).length).toBeGreaterThan(filename.length);
  });

  it("allows an empty filename and rejects a bad magic / short buffer", () => {
    const payload = stringToBytes("data");
    const empty = unpackArtifactEnvelope(packLikeServer("", payload));
    expect(empty.filename).toBe("");
    expect(Array.from(empty.bytes)).toEqual(Array.from(payload));

    // 8 bytes (long enough to clear the header-length check) but a wrong magic →
    // the magic/version check fires.
    expect(() => unpackArtifactEnvelope(stringToBytes("notEVA01"))).toThrow(/magic/);
    // Fewer than the 8-byte header → the length check fires first.
    expect(() => unpackArtifactEnvelope(new Uint8Array(4))).toThrow(/too short/);
  });

  it("rejects a length prefix that overruns the buffer", () => {
    const bad = new Uint8Array(8);
    bad.set([0x45, 0x56, 0x41, 0x31], 0);
    new DataView(bad.buffer).setUint32(4, 999, false); // claims 999-byte name.
    expect(() => unpackArtifactEnvelope(bad)).toThrow(/out of range/);
  });
});

describe("base64 helpers (libsodium ORIGINAL variant)", () => {
  it("round-trips bytes through standard padded base64", () => {
    const { publicKey } = generateKeypair();
    const sealed = sealForSelf(stringToBytes("persist me éà"), publicKey);
    const encoded = toBase64(sealed);
    expect(typeof encoded).toBe("string");
    expect(Array.from(fromBase64(encoded))).toEqual(Array.from(sealed));
  });

  it("emits standard base64 (the ORIGINAL variant: + / and = padding)", () => {
    // 0xFF 0xFE 0xFD -> "//79" under the standard alphabet (not URL-safe).
    expect(toBase64(Uint8Array.from([0xff, 0xfe, 0xfd]))).toBe("//79");
    // A length needing padding produces '=' (ORIGINAL is padded, not NO_PADDING).
    expect(toBase64(Uint8Array.from([0x01])).endsWith("==")).toBe(true);
  });
});

describe("createVault / unlockVault", () => {
  it("creates a vault and unlocks it back to the same key pair", async () => {
    const { blobs, recoveryCode, keyPair } = await createVault("a strong passphrase 42");

    // Blobs are base64 strings sized for the /api/vault schema.
    expect(typeof blobs.publicKey).toBe("string");
    expect(typeof blobs.wrappedPrivateKey).toBe("string");
    expect(typeof blobs.kdfSalt).toBe("string");
    expect(typeof blobs.recoveryWrappedKey).toBe("string");
    expect(blobs.kdfParams.alg).toBe(2); // ALG_ARGON2ID13.
    expect(blobs.kdfParams.recovery?.salt).toBeTypeOf("string");
    // The public key decodes to a 32-byte X25519 key and matches the in-memory pair.
    const decodedPub = fromBase64(blobs.publicKey);
    expect(Array.from(decodedPub)).toEqual(Array.from(keyPair.publicKey));

    const unlocked = await unlockVault("a strong passphrase 42", blobs);
    expect(Array.from(unlocked.publicKey)).toEqual(Array.from(keyPair.publicKey));
    expect(Array.from(unlocked.privateKey)).toEqual(Array.from(keyPair.privateKey));

    // The recovery code is returned but NOT embedded in the uploadable blobs.
    expect(typeof recoveryCode).toBe("string");
    expect(JSON.stringify(blobs)).not.toContain(recoveryCode);
  });

  it("rejects unlock with the wrong passphrase", async () => {
    const { blobs } = await createVault("the right one");
    await expect(unlockVault("the wrong one", blobs)).rejects.toThrow();
  });

  it("recovers the key pair via the recovery code from the uploaded blobs", async () => {
    const { blobs, recoveryCode, keyPair } = await createVault("forgotten later");
    const recovered = await recoverVault(recoveryCode, blobs);
    expect(Array.from(recovered.privateKey)).toEqual(Array.from(keyPair.privateKey));

    await expect(recoverVault("wrong-recovery-code", blobs)).rejects.toThrow();
  });

  it("seals a member secret to self and opens it after unlock (run flow)", async () => {
    const { blobs } = await createVault("family vault pw");
    const unlocked = await unlockVault("family vault pw", blobs);

    // The applicant the client seals to its OWN public key before upload.
    const applicant = stringToBytes(
      JSON.stringify({ docType: "BRP", docNumber: "RY1234567", dob: "1990-04-15" })
    );
    const sealed = sealForSelf(applicant, unlocked.publicKey);
    const opened = openForSelf(sealed, unlocked.publicKey, unlocked.privateKey);
    expect(bytesToString(opened)).toBe(bytesToString(applicant));
  });
});
