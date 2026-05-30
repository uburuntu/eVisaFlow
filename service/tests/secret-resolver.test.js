import assert from "node:assert/strict";
import test from "node:test";
import { encrypt } from "../dist/crypto/encryption.js";
import { SecretResolver } from "../dist/runner/secret-resolver.js";

// 32-byte key encoded as hex (server custody AES key).
const SERVER_KEY_HEX = "00".repeat(32);

const PLAINTEXT_DOC_NUMBER = "SECRET-DOC-987654";
const PLAINTEXT_DOB = "1988-07-15";

function makeMember(overrides = {}) {
  return {
    id: "member-1",
    user_id: "user-1",
    display_name: "Server Member",
    auth_type: "passport",
    encrypted_doc_number: encrypt(PLAINTEXT_DOC_NUMBER, SERVER_KEY_HEX),
    dob_day: 15,
    dob_month: 7,
    dob_year: 1988,
    preferred_2fa_method: "email",
    purpose: "right_to_rent",
    is_active: true,
    sort_order: 0,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * A recording logger that captures every argument passed to any log method,
 * including child loggers, so tests can scan for leaked plaintext.
 */
function makeSpyLogger() {
  const records = [];
  const make = () => {
    const logger = {
      child: () => make(),
    };
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
      logger[level] = (...args) => {
        records.push({ level, args });
      };
    }
    return logger;
  };
  return { logger: make(), records };
}

/** A db stub that forbids any access (client custody must never touch the db). */
function makeForbiddenDb() {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(
          `db must not be accessed in client custody (got .${String(prop)})`
        );
      },
    }
  );
}

test("server custody decrypts the stored doc number into a browser-ready applicant", async () => {
  let getMemberArgs;
  const resolved = await SecretResolver.resolve(
    { kind: "memberRef", userId: "user-1", familyMemberId: "member-1" },
    {
      db: { tag: "db" },
      serverKeyHex: SERVER_KEY_HEX,
      getMember: async (db, memberId, userId) => {
        getMemberArgs = { db, memberId, userId };
        return makeMember();
      },
    }
  );

  assert.deepEqual(getMemberArgs, {
    db: { tag: "db" },
    memberId: "member-1",
    userId: "user-1",
  });
  assert.deepEqual(resolved.applicant, {
    identityDocument: { type: "passport", number: PLAINTEXT_DOC_NUMBER },
    dateOfBirth: "1988-07-15",
  });
  assert.equal(resolved.purpose, "right_to_rent");
  assert.equal(resolved.twoFactorMethod, "email");
  assert.equal(resolved.memberName, "Server Member");
});

test("server custody uses the real decrypt with the default accessor injected", async () => {
  const resolved = await SecretResolver.resolve(
    { kind: "memberRef", userId: "user-1", familyMemberId: "member-1" },
    {
      db: { tag: "db" },
      serverKeyHex: SERVER_KEY_HEX,
      getMember: async () => makeMember({ auth_type: "brc", dob_year: 2001 }),
    }
  );
  assert.equal(resolved.applicant.identityDocument.type, "brc");
  assert.equal(resolved.applicant.identityDocument.number, PLAINTEXT_DOC_NUMBER);
  assert.equal(resolved.applicant.dateOfBirth, "2001-07-15");
});

test("server custody throws when db or key is missing", async () => {
  await assert.rejects(
    SecretResolver.resolve(
      { kind: "memberRef", userId: "u", familyMemberId: "m" },
      { serverKeyHex: SERVER_KEY_HEX }
    ),
    /db is required/
  );
  await assert.rejects(
    SecretResolver.resolve(
      { kind: "memberRef", userId: "u", familyMemberId: "m" },
      { db: {}, getMember: async () => makeMember() }
    ),
    /serverKeyHex is required/
  );
});

test("server custody throws when the member is not found", async () => {
  await assert.rejects(
    SecretResolver.resolve(
      { kind: "memberRef", userId: "u", familyMemberId: "missing" },
      { db: {}, serverKeyHex: SERVER_KEY_HEX, getMember: async () => null }
    ),
    /Family member not found: missing/
  );
});

test("client custody returns the inline applicant unchanged (passthrough)", async () => {
  const inlineApplicant = {
    identityDocument: { type: "nationalId", number: PLAINTEXT_DOC_NUMBER },
    dateOfBirth: PLAINTEXT_DOB,
  };
  const resolved = await SecretResolver.resolve(
    {
      kind: "inline",
      applicant: inlineApplicant,
      purpose: "immigration_status_other",
      twoFactorMethod: "sms",
      memberName: "Inline User",
    },
    { db: makeForbiddenDb(), serverKeyHex: SERVER_KEY_HEX }
  );

  // Same reference: nothing copied/transformed.
  assert.equal(resolved.applicant, inlineApplicant);
  assert.equal(resolved.purpose, "immigration_status_other");
  assert.equal(resolved.twoFactorMethod, "sms");
  assert.equal(resolved.memberName, "Inline User");
});

test("NEGATIVE: client custody leaks no plaintext doc number or DOB to logs or db", async () => {
  const { logger, records } = makeSpyLogger();
  const forbiddenDb = makeForbiddenDb();

  const resolved = await SecretResolver.resolve(
    {
      kind: "inline",
      applicant: {
        identityDocument: { type: "passport", number: PLAINTEXT_DOC_NUMBER },
        dateOfBirth: PLAINTEXT_DOB,
      },
      purpose: "right_to_work",
      twoFactorMethod: "email",
      memberName: "Private User",
    },
    // If the resolver touched the db at all, the proxy throws and the test fails.
    { db: forbiddenDb, serverKeyHex: SERVER_KEY_HEX, log: logger }
  );

  // Sanity: it actually resolved.
  assert.equal(resolved.applicant.identityDocument.number, PLAINTEXT_DOC_NUMBER);

  // Scan every captured log argument (deeply) for the plaintext secrets.
  const haystack = JSON.stringify(records, (_key, value) =>
    value instanceof Uint8Array ? Array.from(value) : value
  );
  assert.ok(
    !haystack.includes(PLAINTEXT_DOC_NUMBER),
    "document number must never be logged in client custody"
  );
  assert.ok(
    !haystack.includes(PLAINTEXT_DOB),
    "date of birth must never be logged in client custody"
  );
  // DOB digit-run form (no separators) must also be absent.
  assert.ok(
    !haystack.includes("19880715") && !haystack.includes("15071988"),
    "date of birth digits must never be logged in client custody"
  );
});

test("NEGATIVE: server custody never logs the plaintext doc number or DOB", async () => {
  const { logger, records } = makeSpyLogger();
  await SecretResolver.resolve(
    { kind: "memberRef", userId: "user-1", familyMemberId: "member-1" },
    {
      db: { tag: "db" },
      serverKeyHex: SERVER_KEY_HEX,
      getMember: async () => makeMember(),
      log: logger,
    }
  );

  const haystack = JSON.stringify(records);
  assert.ok(
    !haystack.includes(PLAINTEXT_DOC_NUMBER),
    "decrypted document number must never be logged"
  );
  assert.ok(
    !haystack.includes("1988-07-15") && !haystack.includes("19880715"),
    "decrypted date of birth must never be logged"
  );
  // It is fine (and expected) to log non-secret structure such as the doc type.
  assert.ok(haystack.includes("passport"));
});
