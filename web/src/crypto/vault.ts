import sodium from "libsodium-wrappers-sumo";

/**
 * In-browser E2EE vault, byte-compatible with the server's seal primitives.
 *
 * This is the client half of eVisaFlow's client-custody model. The passphrase
 * and the unwrapped X25519 private key NEVER leave the browser: the server only
 * ever receives the opaque blobs produced here ({@link createVault}) and returns
 * them verbatim for {@link unlockVault}. Every byte layout here is deliberately
 * identical to `service/src/crypto/seal.ts` so that:
 *
 *   - the worker can `crypto_box_seal` a run's outputs to {@link VaultBlobs.publicKey}
 *     and the browser can {@link openForSelf} / {@link openSealedArtifact} them, and
 *   - member secrets sealed in the browser to the user's OWN public key open with
 *     the same `crypto_box_seal_open`.
 *
 * Compatibility contract (must match the server):
 *   - X25519 key pair via `crypto_box_keypair`.
 *   - Argon2id via `crypto_pwhash` with `ALG_ARGON2ID13`; ops/mem-limit and alg
 *     are returned in {@link KdfParams} and stored server-side so re-login
 *     reproduces the exact key.
 *   - Private-key wrapping via `crypto_secretbox_easy` with the 24-byte nonce
 *     PREPENDED to the ciphertext.
 *   - Anonymous sealing via `crypto_box_seal` / `crypto_box_seal_open`.
 *   - The sealed-artifact envelope is the EXACT "EVA1" layout packed by
 *     `service/src/crypto/seal.ts` (`packArtifactEnvelope`).
 *   - base64 is libsodium `base64_variants.ORIGINAL` (standard, padded), matching
 *     the server's `toBase64`/`fromBase64`.
 *
 * This imports `libsodium-wrappers-sumo` (the "sumo" build), NOT the standard
 * `libsodium-wrappers` the server uses: the vault's Argon2id KDF (`crypto_pwhash`)
 * lives ONLY in sumo. The server never derives a passphrase key, so it stays on
 * the smaller standard build; the shared sealing primitives (`crypto_box_seal`,
 * `crypto_secretbox`, base64) are byte-identical across both, so every blob this
 * module produces opens with the server's build and vice versa.
 *
 * Unlike the server (which loads libsodium's CommonJS build via `createRequire`
 * to dodge a broken ESM entry under pnpm), the browser bundle imports the ESM
 * build directly — Vite resolves and ships the WASM. Only the IMPORT mechanism
 * differs; every byte produced is identical.
 */

let readyPromise: Promise<typeof sodium> | undefined;

/**
 * Resolves once libsodium's WASM runtime is initialized. Memoized, so callers may
 * `await ready()` freely before any other export. Every other function here
 * assumes the runtime is ready; always `await ready()` first (the vault helpers
 * do this for you).
 */
export function ready(): Promise<typeof sodium> {
  if (!readyPromise) {
    readyPromise = sodium.ready.then(() => sodium);
  }
  return readyPromise;
}

/** An X25519 key pair for anonymous sealing (the vault's identity key). */
export interface BoxKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Argon2id parameters, stored alongside the salt so a future login reproduces the
 * exact wrap key from the passphrase. These are NOT secret — they travel with the
 * vault blobs. `alg` is libsodium's numeric algorithm id (`ALG_ARGON2ID13`); it is
 * persisted so a future libsodium default change can never silently break unlock.
 */
export interface KdfParams {
  opslimit: number;
  memlimit: number;
  alg: number;
}

/**
 * Generates an X25519 key pair (`crypto_box_keypair`). The public key is what the
 * worker seals outputs to and what member secrets are sealed to; the private key
 * is wrapped with the passphrase and never persisted in the clear.
 */
export function generateKeypair(): BoxKeyPair {
  const pair = sodium.crypto_box_keypair();
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

/** A fresh Argon2id salt (`crypto_pwhash_SALTBYTES`, 16 bytes). */
export function generateKdfSalt(): Uint8Array {
  return sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
}

/**
 * Default Argon2id work factors. MODERATE is a deliberate balance for a browser
 * WASM context with a non-technical, ESL audience: meaningfully stronger than
 * INTERACTIVE without the multi-second, multi-hundred-MiB cost of SENSITIVE that
 * can OOM a phone. Returned in {@link KdfParams} so it is reproducible and tunable
 * later without breaking existing vaults.
 */
export function defaultKdfParams(): KdfParams {
  return {
    opslimit: sodium.crypto_pwhash_OPSLIMIT_MODERATE,
    memlimit: sodium.crypto_pwhash_MEMLIMIT_MODERATE,
    alg: sodium.crypto_pwhash_ALG_ARGON2ID13,
  };
}

/**
 * Derives a 32-byte symmetric wrap key from `passphrase` + `salt` via Argon2id
 * (`crypto_pwhash`). Deterministic: the same passphrase, salt, and params always
 * yield the same key (this is what makes re-login work); a different salt yields a
 * different key. The output length is `crypto_secretbox_KEYBYTES` so the result is
 * a valid `crypto_secretbox` key. Pass the SAME `params` that were stored at
 * vault creation. Requires {@link ready}.
 */
export function deriveWrapKey(
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams = defaultKdfParams()
): Uint8Array {
  if (salt.length !== sodium.crypto_pwhash_SALTBYTES) {
    throw new Error(
      `kdf salt must be ${sodium.crypto_pwhash_SALTBYTES} bytes; got ${salt.length}`
    );
  }
  return sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    passphrase,
    salt,
    params.opslimit,
    params.memlimit,
    params.alg
  );
}

/**
 * Wraps `privateKey` under `wrapKey` with `crypto_secretbox_easy`, PREPENDING the
 * fresh 24-byte nonce to the ciphertext: `[24]nonce || secretbox(privateKey)`.
 * The prepended-nonce convention is what {@link unwrapPrivateKey} expects.
 */
export function wrapPrivateKey(privateKey: Uint8Array, wrapKey: Uint8Array): Uint8Array {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const cipher = sodium.crypto_secretbox_easy(privateKey, nonce, wrapKey);
  const out = new Uint8Array(nonce.length + cipher.length);
  out.set(nonce, 0);
  out.set(cipher, nonce.length);
  return out;
}

/**
 * Inverse of {@link wrapPrivateKey}: splits the leading 24-byte nonce, then opens
 * the remainder with `crypto_secretbox_open_easy`. Throws if `wrapped` is too
 * short or if the key/nonce do not authenticate (wrong passphrase ⇒ wrong wrap
 * key ⇒ throw — this is how unlock detects a bad passphrase).
 */
export function unwrapPrivateKey(wrapped: Uint8Array, wrapKey: Uint8Array): Uint8Array {
  const nonceLen = sodium.crypto_secretbox_NONCEBYTES;
  if (wrapped.length < nonceLen + sodium.crypto_secretbox_MACBYTES) {
    throw new Error("wrapped private key is too short");
  }
  const nonce = wrapped.subarray(0, nonceLen);
  const cipher = wrapped.subarray(nonceLen);
  return sodium.crypto_secretbox_open_easy(cipher, nonce, wrapKey);
}

/**
 * Number of random bytes behind a recovery code. 32 bytes = 256 bits of entropy,
 * far beyond any passphrase, so the recovery kit is a true second factor for the
 * private key rather than a weaker side door.
 */
const RECOVERY_CODE_BYTES = 32;

/**
 * A recovery kit: a high-entropy recovery code (shown to the user ONCE, never
 * uploaded) plus a SECOND wrapped copy of the private key, unlockable by that
 * code. If the passphrase is forgotten, the code re-derives a wrap key and
 * recovers the same private key. The code's own KDF salt/params travel inside the
 * recovery blob layout via {@link unwrapWithRecoveryCode}'s expectations.
 */
export interface RecoveryKit {
  /** Human-facing recovery code (base64). Display once; NEVER upload. */
  recoveryCode: string;
  /** Second wrapped private key, openable by {@link recoveryCode}. Stored server-side. */
  recoveryWrappedKey: Uint8Array;
  /** Salt used to derive the recovery wrap key. Embedded so unlock is reproducible. */
  recoverySalt: Uint8Array;
  /** Argon2id params used for the recovery wrap key. */
  recoveryParams: KdfParams;
}

/**
 * Builds a recovery kit for `privateKey`: generates a 256-bit recovery code,
 * derives an independent Argon2id wrap key from it (its own fresh salt), and wraps
 * a second copy of the private key. Returns the code (display-once) and the
 * wrapped copy plus its salt/params for storage. The recovery code is NEVER sent
 * to the server.
 */
export function createRecoveryKit(privateKey: Uint8Array): RecoveryKit {
  const recoveryCode = toBase64(sodium.randombytes_buf(RECOVERY_CODE_BYTES));
  const recoverySalt = generateKdfSalt();
  const recoveryParams = defaultKdfParams();
  const recoveryWrapKey = deriveWrapKey(recoveryCode, recoverySalt, recoveryParams);
  const recoveryWrappedKey = wrapPrivateKey(privateKey, recoveryWrapKey);
  return { recoveryCode, recoveryWrappedKey, recoverySalt, recoveryParams };
}

/**
 * Recovers the private key from a recovery code + the stored recovery blob. The
 * caller supplies the same `recoverySalt`/`recoveryParams` produced at
 * {@link createRecoveryKit} time. Throws on a wrong recovery code (the secretbox
 * fails to authenticate).
 */
export function unwrapWithRecoveryCode(
  recoveryWrappedKey: Uint8Array,
  recoveryCode: string,
  recoverySalt: Uint8Array,
  recoveryParams: KdfParams
): Uint8Array {
  const recoveryWrapKey = deriveWrapKey(recoveryCode, recoverySalt, recoveryParams);
  return unwrapPrivateKey(recoveryWrappedKey, recoveryWrapKey);
}

/**
 * Asserts `key` is a well-formed X25519 public key (`crypto_box_PUBLICKEYBYTES`,
 * 32 bytes), mirroring the server's `assertPublicKey`. libsodium otherwise throws
 * an opaque error deep in the WASM; this fails fast with a clear message before
 * any sealing.
 */
export function assertPublicKey(key: Uint8Array): void {
  const expected = sodium.crypto_box_PUBLICKEYBYTES;
  if (key.length !== expected) {
    throw new Error(`public key must be ${expected} bytes (X25519); got ${key.length}`);
  }
}

/**
 * Seals `plaintext` to the user's OWN public key with `crypto_box_seal`
 * (anonymous sender). Used to store member secrets so only this vault's private
 * key can open them. Identical primitive to the server's `sealToPublicKey`, so
 * the server's open path (tests only) and {@link openForSelf} are interchangeable.
 */
export function sealForSelf(plaintext: Uint8Array, publicKey: Uint8Array): Uint8Array {
  assertPublicKey(publicKey);
  return sodium.crypto_box_seal(plaintext, publicKey);
}

/**
 * Opens bytes sealed to the user's public key (`crypto_box_seal_open`) using the
 * unwrapped key pair. Used to recover a member's sealed secret in memory before a
 * run. Throws if the ciphertext was tampered with or the keys do not match.
 */
export function openForSelf(
  sealed: Uint8Array,
  publicKey: Uint8Array,
  privateKey: Uint8Array
): Uint8Array {
  return sodium.crypto_box_seal_open(sealed, publicKey, privateKey);
}

/**
 * Magic + version prefix for a sealed-artifact envelope, byte-identical to
 * `service/src/crypto/seal.ts`. ASCII "EVA1" (eVisa Artifact v1).
 */
const ARTIFACT_ENVELOPE_MAGIC = Uint8Array.from([0x45, 0x56, 0x41, 0x31]);

/** Header is the 4-byte magic plus a 4-byte big-endian uint32 filename length. */
const ARTIFACT_HEADER_BYTES = 8;

/**
 * Inverse of the server's `packArtifactEnvelope`: recovers `{ filename, bytes }`
 * from a DECRYPTED artifact envelope. Layout (all big-endian), EXACTLY as the
 * server packs it:
 *
 *   [4]  magic "EVA1"
 *   [4]  filename byte length (uint32, big-endian)
 *   [n]  filename (UTF-8)
 *   [..] artifact bytes (remainder)
 *
 * Throws on a wrong magic/version or an inconsistent length prefix. This is the
 * client-only counterpart; the server never opens client-custody envelopes.
 */
export function unpackArtifactEnvelope(envelope: Uint8Array): {
  filename: string;
  bytes: Uint8Array;
} {
  if (envelope.length < ARTIFACT_HEADER_BYTES) {
    throw new Error("artifact envelope is too short");
  }
  for (let i = 0; i < ARTIFACT_ENVELOPE_MAGIC.length; i += 1) {
    if (envelope[i] !== ARTIFACT_ENVELOPE_MAGIC[i]) {
      throw new Error("artifact envelope has an unexpected magic/version");
    }
  }
  const nameLen = new DataView(envelope.buffer, envelope.byteOffset + 4, 4).getUint32(
    0,
    false
  );
  if (ARTIFACT_HEADER_BYTES + nameLen > envelope.length) {
    throw new Error("artifact envelope filename length is out of range");
  }
  const filename = sodium.to_string(
    envelope.subarray(ARTIFACT_HEADER_BYTES, ARTIFACT_HEADER_BYTES + nameLen)
  );
  const bytes = envelope.subarray(ARTIFACT_HEADER_BYTES + nameLen);
  return { filename, bytes };
}

/**
 * Opens a sealed artifact end to end: `crypto_box_seal_open` with the vault key
 * pair, then {@link unpackArtifactEnvelope} to recover `{ filename, bytes }`. This
 * is the single call the run screen uses on each `artifact_ready` payload (PDF or
 * checker HTML). Nothing decrypted here is ever uploaded back.
 */
export function openSealedArtifact(
  sealed: Uint8Array,
  publicKey: Uint8Array,
  privateKey: Uint8Array
): { filename: string; bytes: Uint8Array } {
  const envelope = sodium.crypto_box_seal_open(sealed, publicKey, privateKey);
  return unpackArtifactEnvelope(envelope);
}

/** Encodes bytes as standard (padded) base64 — libsodium `ORIGINAL` variant. */
export function toBase64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
}

/** Decodes standard (padded) base64 produced by {@link toBase64}. */
export function fromBase64(text: string): Uint8Array {
  return sodium.from_base64(text, sodium.base64_variants.ORIGINAL);
}

/** UTF-8 string → bytes (libsodium helper). */
export function stringToBytes(text: string): Uint8Array {
  return sodium.from_string(text);
}

/** Bytes → UTF-8 string (libsodium helper). */
export function bytesToString(bytes: Uint8Array): string {
  return sodium.to_string(bytes);
}

/**
 * The opaque vault blobs POSTed to `POST /api/vault` and returned by `GET
 * /api/vault`. base64 strings exactly as the route schema expects. The
 * `recoveryCode` is deliberately ABSENT — it is shown to the user once and never
 * uploaded (see {@link CreateVaultResult}).
 */
export interface VaultBlobs {
  publicKey: string;
  wrappedPrivateKey: string;
  kdfSalt: string;
  /**
   * Argon2id params plus the recovery-kit salt/params, stored verbatim as JSON so
   * a future login reproduces both wrap keys. Opaque to the server.
   */
  kdfParams: VaultKdfParamsJson;
  recoveryWrappedKey?: string;
}

/**
 * JSON shape persisted in `user_vault.kdf_params`. Holds the passphrase KDF params
 * and (when a recovery kit exists) the recovery KDF salt+params, so unlock and
 * recovery are both fully reproducible from the stored vault alone. The recovery
 * CODE itself is never stored here.
 */
export interface VaultKdfParamsJson extends KdfParams {
  recovery?: {
    salt: string;
    params: KdfParams;
  };
}

/**
 * Result of {@link createVault}: the {@link VaultBlobs} to upload, plus the
 * one-time `recoveryCode` to SHOW the user and never persist. The in-memory
 * `keyPair` is returned so the caller can use the vault immediately after setup
 * without a redundant unlock.
 */
export interface CreateVaultResult {
  blobs: VaultBlobs;
  recoveryCode: string;
  keyPair: BoxKeyPair;
}

/**
 * Creates a brand-new vault from a passphrase. Generates the X25519 identity key
 * pair, derives the Argon2id wrap key (fresh salt, default params), wraps the
 * private key, and builds a mandatory recovery kit. Returns the opaque blobs to
 * POST to `/api/vault`, the one-time recovery code (display once, NEVER upload),
 * and the in-memory key pair. The passphrase and private key never leave the
 * browser. Requires nothing pre-initialized — it awaits {@link ready} itself.
 */
export async function createVault(passphrase: string): Promise<CreateVaultResult> {
  await ready();
  const keyPair = generateKeypair();

  const kdfSalt = generateKdfSalt();
  const kdfParams = defaultKdfParams();
  const wrapKey = deriveWrapKey(passphrase, kdfSalt, kdfParams);
  const wrappedPrivateKey = wrapPrivateKey(keyPair.privateKey, wrapKey);

  const recovery = createRecoveryKit(keyPair.privateKey);

  const blobs: VaultBlobs = {
    publicKey: toBase64(keyPair.publicKey),
    wrappedPrivateKey: toBase64(wrappedPrivateKey),
    kdfSalt: toBase64(kdfSalt),
    kdfParams: {
      ...kdfParams,
      recovery: {
        salt: toBase64(recovery.recoverySalt),
        params: recovery.recoveryParams,
      },
    },
    recoveryWrappedKey: toBase64(recovery.recoveryWrappedKey),
  };

  return { blobs, recoveryCode: recovery.recoveryCode, keyPair };
}

/**
 * Unlocks a vault from a passphrase and the blobs returned by `GET /api/vault`.
 * Re-derives the wrap key with the STORED salt+params (so it must match
 * creation), unwraps the private key, and returns the key pair IN MEMORY ONLY.
 * Throws on a wrong passphrase (the secretbox fails to authenticate). The private
 * key is never persisted or re-uploaded. Requires nothing pre-initialized.
 */
export async function unlockVault(
  passphrase: string,
  vaultBlobs: VaultBlobs
): Promise<BoxKeyPair> {
  await ready();
  const publicKey = fromBase64(vaultBlobs.publicKey);
  const kdfSalt = fromBase64(vaultBlobs.kdfSalt);
  const wrapKey = deriveWrapKey(passphrase, kdfSalt, vaultBlobs.kdfParams);
  const privateKey = unwrapPrivateKey(fromBase64(vaultBlobs.wrappedPrivateKey), wrapKey);
  return { publicKey, privateKey };
}

/**
 * Recovers a vault's key pair using the recovery code instead of the passphrase.
 * Reads the recovery salt/params embedded in {@link VaultBlobs.kdfParams} and the
 * stored `recoveryWrappedKey`. Throws if the vault has no recovery kit or the code
 * is wrong. The caller can then re-wrap under a new passphrase via
 * {@link createVault}-style steps (a higher-level concern, not done here).
 */
export async function recoverVault(
  recoveryCode: string,
  vaultBlobs: VaultBlobs
): Promise<BoxKeyPair> {
  await ready();
  const recovery = vaultBlobs.kdfParams.recovery;
  if (!recovery || !vaultBlobs.recoveryWrappedKey) {
    throw new Error("vault has no recovery kit");
  }
  const publicKey = fromBase64(vaultBlobs.publicKey);
  const privateKey = unwrapWithRecoveryCode(
    fromBase64(vaultBlobs.recoveryWrappedKey),
    recoveryCode,
    fromBase64(recovery.salt),
    recovery.params
  );
  return { publicKey, privateKey };
}
