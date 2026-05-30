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
 * Seals `plaintext` to `recipientPublicKey` using `crypto_box_seal` (anonymous
 * sender). Only the public key is required — no sender secret or passphrase — so
 * this is safe to call from the worker for async/scheduled delivery. Returns the
 * raw sealed bytes; persist/transmit these (or their base64 form) only.
 */
export function sealToPublicKey(
  plaintext: Uint8Array,
  recipientPublicKey: Uint8Array
): Uint8Array {
  return sodium.crypto_box_seal(plaintext, recipientPublicKey);
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
