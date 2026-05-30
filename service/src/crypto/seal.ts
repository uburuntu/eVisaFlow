import { createRequire } from "node:module";

/**
 * Anonymous public-key sealing (libsodium `crypto_box_seal`).
 *
 * This is the client-custody primitive: the worker seals a run's outputs to the
 * recipient's X25519 *public* key. Sealing is anonymous — it needs no secret,
 * passphrase, or sender key — so the worker can seal asynchronously (e.g. for a
 * scheduled run) and still produce ciphertext only the holder of the matching
 * private key can open. The server therefore never possesses, and must never
 * use, the private-key open path for client data; {@link openSealed} exists only
 * for the client and for tests.
 *
 * libsodium-wrappers ships a broken ESM build under pnpm's non-hoisted layout
 * (its `.mjs` does a sibling `import "./libsodium.mjs"` that resolves into the
 * separate `libsodium` package and 404s). We therefore load the working CommonJS
 * entry via `createRequire`, typed against the package's own declarations.
 */
const require = createRequire(import.meta.url);
type Sodium = typeof import("libsodium-wrappers");
const sodium = require("libsodium-wrappers") as Sodium;

let readyPromise: Promise<Sodium> | undefined;

/**
 * Resolves once libsodium's WASM runtime is initialized. Memoized, so callers
 * may `await ready()` freely before any other export. Every other function in
 * this module assumes the runtime is ready; always `await ready()` first.
 */
export function ready(): Promise<Sodium> {
  if (!readyPromise) {
    readyPromise = sodium.ready.then(() => sodium);
  }
  return readyPromise;
}

/** An X25519 key pair for anonymous sealing (vault key material; tests). */
export interface BoxKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Generates an X25519 key pair (`crypto_box_keypair`).
 *
 * The public key is what outputs are sealed to; the private key never leaves the
 * holder (the browser vault, or a test). The server stores/uses only public
 * keys for client custody. Requires {@link ready} to have resolved.
 */
export function generateBoxKeypair(): BoxKeyPair {
  const pair = sodium.crypto_box_keypair();
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

/**
 * Asserts `key` is a well-formed X25519 public key (`crypto_box_PUBLICKEYBYTES`,
 * i.e. 32 bytes). libsodium throws an opaque "invalid publicKey length" deep in
 * the WASM otherwise; this fails fast with a clear, greppable message before any
 * sealing, so a malformed key (e.g. an empty `Uint8Array(0)`, which is truthy)
 * cannot slip past a mere truthiness check. Requires {@link ready} to have
 * resolved (the constant is read off the initialized runtime).
 */
export function assertPublicKey(key: Uint8Array): void {
  const expected = sodium.crypto_box_PUBLICKEYBYTES;
  if (key.length !== expected) {
    throw new Error(
      `recipientPublicKey must be ${expected} bytes (X25519); got ${key.length}`
    );
  }
}

/**
 * Seals `plaintext` to `recipientPublicKey` using `crypto_box_seal` (anonymous
 * sender). Only the public key is required — no sender secret or passphrase — so
 * this is safe to call from the worker for async/scheduled delivery. Returns the
 * raw sealed bytes; persist/transmit these (or their base64 form) only. Validates
 * the key length first so a malformed key fails with a clear message.
 */
export function sealToPublicKey(
  plaintext: Uint8Array,
  recipientPublicKey: Uint8Array
): Uint8Array {
  assertPublicKey(recipientPublicKey);
  return sodium.crypto_box_seal(plaintext, recipientPublicKey);
}

/**
 * Magic + version prefix for a sealed-artifact envelope. Bumping the version lets
 * the in-browser opener detect format changes. ASCII "EVA1" (eVisa Artifact v1).
 */
const ARTIFACT_ENVELOPE_MAGIC = Uint8Array.from([0x45, 0x56, 0x41, 0x31]);

/**
 * Packs an artifact's `filename` together with its `bytes` into a single binary
 * envelope, so the filename can be sealed alongside the payload and never has to
 * be stored in plaintext at rest. Layout (all big-endian):
 *
 *   [4]  magic "EVA1"
 *   [4]  filename byte length (uint32)
 *   [n]  filename (UTF-8)
 *   [..] artifact bytes (remainder)
 *
 * This keeps the member's identity (real filenames embed surname/given-name and
 * the visa expiry, and the checker fallback can embed the share code) inside the
 * sealed blob for client custody. Length-prefixed binary, so it is cheap even for
 * multi-MiB PDFs (no base64/JSON blow-up). Open the sealed bytes, then
 * {@link unpackArtifactEnvelope} to recover `{ filename, bytes }`.
 */
export function packArtifactEnvelope(filename: string, bytes: Uint8Array): Uint8Array {
  const nameBytes = sodium.from_string(filename);
  const header = new Uint8Array(8);
  header.set(ARTIFACT_ENVELOPE_MAGIC, 0);
  new DataView(header.buffer).setUint32(4, nameBytes.length, false);
  const out = new Uint8Array(header.length + nameBytes.length + bytes.length);
  out.set(header, 0);
  out.set(nameBytes, header.length);
  out.set(bytes, header.length + nameBytes.length);
  return out;
}

/**
 * Inverse of {@link packArtifactEnvelope}: recovers `{ filename, bytes }` from an
 * opened (decrypted) artifact envelope. Throws if the magic/version is wrong or
 * the length prefix is inconsistent. For the client and tests; the server never
 * opens client-custody envelopes.
 */
export function unpackArtifactEnvelope(envelope: Uint8Array): {
  filename: string;
  bytes: Uint8Array;
} {
  if (envelope.length < 8) {
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
  if (8 + nameLen > envelope.length) {
    throw new Error("artifact envelope filename length is out of range");
  }
  const filename = sodium.to_string(envelope.subarray(8, 8 + nameLen));
  const bytes = envelope.subarray(8 + nameLen);
  return { filename, bytes };
}

/**
 * Opens sealed bytes with the recipient key pair (`crypto_box_seal_open`).
 *
 * For the client and for tests ONLY. The server holds no private key for
 * client-custody data and must never call this on client ciphertext. Throws if
 * the ciphertext was tampered with or the keys do not match.
 */
export function openSealed(
  sealed: Uint8Array,
  publicKey: Uint8Array,
  privateKey: Uint8Array
): Uint8Array {
  return sodium.crypto_box_seal_open(sealed, publicKey, privateKey);
}

/** Encodes bytes as standard (padded) base64 for storage in a TEXT column. */
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
