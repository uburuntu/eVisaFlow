import { describe, expect, it } from "vitest";
import { decodeJsonBytes, sealedShareCodeBytes } from "./run-events.js";

/**
 * Tests for the SSE event decoding contract. The single subtlety these pin: the
 * server serialises run events with `JSON.stringify`, which turns a `Uint8Array`
 * (the `completed` event's sealed share-code bytes) into a plain object of
 * index→byte — NOT a JSON array. If the browser mis-decoded that, the share code
 * would never open. {@link decodeJsonBytes} must reconstruct the exact bytes from
 * any of the forms a buffer can take across JSON.
 */
describe("decodeJsonBytes", () => {
  it("reconstructs bytes from the index→byte object JSON.stringify emits", () => {
    const original = new Uint8Array([0, 1, 2, 254, 255]);
    // This is exactly what crosses SSE: JSON.parse(JSON.stringify(uint8array)).
    const overWire = JSON.parse(JSON.stringify(original));
    expect(Array.isArray(overWire)).toBe(false); // sanity: it's an object, not array
    const decoded = decodeJsonBytes(overWire);
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded ?? [])).toEqual([0, 1, 2, 254, 255]);
  });

  it("accepts a JSON array of numbers", () => {
    const decoded = decodeJsonBytes([10, 20, 30]);
    expect(Array.from(decoded ?? [])).toEqual([10, 20, 30]);
  });

  it("passes through a real Uint8Array unchanged", () => {
    const u = new Uint8Array([7, 8, 9]);
    expect(decodeJsonBytes(u)).toBe(u);
  });

  it("returns undefined for null/undefined", () => {
    expect(decodeJsonBytes(null)).toBeUndefined();
    expect(decodeJsonBytes(undefined)).toBeUndefined();
  });

  it("preserves byte order regardless of object key enumeration order", () => {
    // Keys deliberately out of order; decoder must place each byte at its index.
    const scrambled = { "2": 30, "0": 10, "1": 20 };
    expect(Array.from(decodeJsonBytes(scrambled) ?? [])).toEqual([10, 20, 30]);
  });
});

describe("sealedShareCodeBytes", () => {
  it("extracts box_seal bytes from a completed event", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const event = {
      type: "completed" as const,
      validUntil: "2026-01-01",
      sealedShareCode: {
        alg: "box_seal" as const,
        bytes: JSON.parse(JSON.stringify(bytes)),
      },
    };
    expect(Array.from(sealedShareCodeBytes(event) ?? [])).toEqual([1, 2, 3]);
  });

  it("returns undefined when there is no share code", () => {
    const event = {
      type: "completed" as const,
      sealedShareCode: { alg: "box_seal" as const },
    };
    expect(sealedShareCodeBytes(event)).toBeUndefined();
  });

  it("ignores a non-box_seal blob (the web app is always client custody)", () => {
    const event = {
      type: "completed" as const,
      sealedShareCode: { alg: "aesgcm" as const, cipher: "x" },
    };
    expect(sealedShareCodeBytes(event)).toBeUndefined();
  });
});
