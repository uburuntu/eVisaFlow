import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  decrypt,
  decryptBytes,
  encrypt,
  encryptBytes,
} from "../dist/crypto/encryption.js";

const key = randomBytes(32).toString("hex");

test("encrypt/decrypt roundtrip preserves plaintext without returning plaintext", () => {
  const encrypted = encrypt("AB1234567", key);

  assert.notEqual(encrypted, "AB1234567");
  assert.equal(decrypt(encrypted, key), "AB1234567");
});

test("decrypt rejects tampered ciphertext", () => {
  const encrypted = encrypt("AB1234567", key);
  const parts = encrypted.split(":");
  const ciphertext = Buffer.from(parts[1], "base64");
  ciphertext[0] ^= 0xff;
  parts[1] = ciphertext.toString("base64");

  assert.throws(() => decrypt(parts.join(":"), key));
});

test("decrypt rejects malformed ciphertext", () => {
  assert.throws(() => decrypt("not:enough", key), /malformed/);
});

test("binary encryption roundtrip preserves artifact bytes", () => {
  const plaintext = new Uint8Array([0, 1, 2, 3, 254, 255]);
  const encrypted = encryptBytes(plaintext, key);
  assert.notDeepEqual(encrypted, Buffer.from(plaintext));
  assert.deepEqual(decryptBytes(encrypted, key), Buffer.from(plaintext));
});
