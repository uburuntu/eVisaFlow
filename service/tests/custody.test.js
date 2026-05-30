import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { clientCustody, serverCustody } from "../dist/crypto/custody.js";
import {
  bytesToString,
  generateBoxKeypair,
  openSealed,
  ready,
  stringToBytes,
  unpackArtifactEnvelope,
} from "../dist/crypto/seal.js";

const serverKeyHex = randomBytes(32).toString("hex");

test("server custody seals the share code with AES and opens it back", () => {
  const provider = serverCustody(serverKeyHex);
  assert.equal(provider.custody, "server");

  const blob = provider.sealShareCode("ABCD-1234", {});
  assert.equal(blob.alg, "aesgcm");
  assert.equal(typeof blob.cipher, "string");
  // The ciphertext must not contain the plaintext.
  assert.ok(!blob.cipher.includes("ABCD-1234"));

  const opened = provider.openForDelivery(blob);
  assert.equal(bytesToString(opened), "ABCD-1234");
});

test("server custody carries artifact bytes raw for the trusted bot", () => {
  const provider = serverCustody(serverKeyHex);
  const bytes = Uint8Array.from([1, 2, 3, 4, 5]);

  const blob = provider.sealArtifact(bytes, {});
  assert.equal(blob.alg, "aesgcm");
  assert.deepEqual(blob.bytes, bytes);

  // openForDelivery returns the raw artifact bytes unchanged.
  assert.deepEqual(provider.openForDelivery(blob), bytes);
});

test("client custody seals so only the matching private key opens", async () => {
  await ready();
  const recipient = generateBoxKeypair();
  const provider = clientCustody();
  assert.equal(provider.custody, "client");

  const codeBlob = provider.sealShareCode("WXYZ-9999", {
    recipientPublicKey: recipient.publicKey,
  });
  assert.equal(codeBlob.alg, "box_seal");
  assert.ok(codeBlob.bytes instanceof Uint8Array);
  assert.equal(codeBlob.cipher, undefined);

  // The matching private key opens it.
  const opened = openSealed(codeBlob.bytes, recipient.publicKey, recipient.privateKey);
  assert.equal(bytesToString(opened), "WXYZ-9999");

  // A different key pair cannot.
  const stranger = generateBoxKeypair();
  assert.throws(() =>
    openSealed(codeBlob.bytes, stranger.publicKey, stranger.privateKey)
  );
});

test("client custody seals the filename + bytes into the artifact envelope", async () => {
  await ready();
  const recipient = generateBoxKeypair();
  const provider = clientCustody();
  const bytes = stringToBytes("pdf-bytes-stand-in");
  // A filename that embeds identity, exactly the kind that must not be at rest.
  const filename = "EVISA_SMITH_JOHN_2031-03-03.pdf";

  const blob = provider.sealArtifact(bytes, {
    recipientPublicKey: recipient.publicKey,
    filename,
  });
  assert.equal(blob.alg, "box_seal");
  assert.notDeepEqual(blob.bytes, bytes);
  // The sealed bytes leak neither the payload nor the identity-bearing filename.
  const sealedText = new TextDecoder().decode(blob.bytes);
  assert.ok(!sealedText.includes("SMITH"));
  assert.ok(!sealedText.includes("pdf-bytes-stand-in"));

  // The client opens the blob and unpacks the original filename AND bytes.
  const opened = openSealed(blob.bytes, recipient.publicKey, recipient.privateKey);
  const unpacked = unpackArtifactEnvelope(opened);
  assert.equal(unpacked.filename, filename);
  assert.deepEqual(unpacked.bytes, bytes);
});

test("client custody requires a recipient public key to seal", () => {
  const provider = clientCustody();
  assert.throws(() => provider.sealShareCode("x", {}), /recipientPublicKey/);
  assert.throws(
    () => provider.sealArtifact(Uint8Array.from([0]), {}),
    /recipientPublicKey/
  );
});

test("client custody exposes no openForDelivery (server holds no private key)", () => {
  const provider = clientCustody();
  assert.equal(provider.openForDelivery, undefined);
});
