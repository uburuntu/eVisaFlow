import assert from "node:assert/strict";
import test from "node:test";
import {
  bytesToString,
  fromBase64,
  generateBoxKeypair,
  openSealed,
  ready,
  sealToPublicKey,
  stringToBytes,
  toBase64,
} from "../dist/crypto/seal.js";

test("keypair → seal → open round-trips the plaintext", async () => {
  await ready();
  const { publicKey, privateKey } = generateBoxKeypair();
  assert.equal(publicKey.length, 32);
  assert.equal(privateKey.length, 32);

  const plaintext = stringToBytes("share-code: ABCD-1234");
  const sealed = sealToPublicKey(plaintext, publicKey);

  // Sealed bytes are not the plaintext, and carry the crypto_box_seal overhead.
  assert.notDeepEqual(sealed, plaintext);
  assert.equal(sealed.length, plaintext.length + 48);

  const opened = openSealed(sealed, publicKey, privateKey);
  assert.equal(bytesToString(opened), "share-code: ABCD-1234");
});

test("tampered ciphertext fails to open", async () => {
  await ready();
  const { publicKey, privateKey } = generateBoxKeypair();
  const sealed = sealToPublicKey(stringToBytes("top secret"), publicKey);

  const tampered = Uint8Array.from(sealed);
  tampered[tampered.length - 1] ^= 0xff;

  assert.throws(() => openSealed(tampered, publicKey, privateKey));
});

test("sealToPublicKey needs only the public key (anonymous sender)", async () => {
  await ready();
  // A recipient generated entirely independently of the sealer: the sealer is
  // handed nothing but the public key and can still produce openable ciphertext.
  const recipient = generateBoxKeypair();
  const recipientPublicKeyOnly = recipient.publicKey;

  const sealed = sealToPublicKey(
    stringToBytes("for your eyes only"),
    recipientPublicKeyOnly
  );

  // Only the matching private key opens it.
  const opened = openSealed(sealed, recipient.publicKey, recipient.privateKey);
  assert.equal(bytesToString(opened), "for your eyes only");

  // A different key pair cannot open it.
  const stranger = generateBoxKeypair();
  assert.throws(() => openSealed(sealed, stranger.publicKey, stranger.privateKey));
});

test("base64 helpers round-trip sealed bytes for TEXT storage", async () => {
  await ready();
  const { publicKey, privateKey } = generateBoxKeypair();
  const sealed = sealToPublicKey(stringToBytes("persist me"), publicKey);

  const encoded = toBase64(sealed);
  assert.equal(typeof encoded, "string");

  const decoded = fromBase64(encoded);
  assert.deepEqual(decoded, sealed);

  // The decoded bytes still open correctly.
  assert.equal(bytesToString(openSealed(decoded, publicKey, privateKey)), "persist me");
});
