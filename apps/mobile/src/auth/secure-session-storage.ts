import {
  AESEncryptionKey,
  AESSealedData,
  aesDecryptAsync,
  aesEncryptAsync,
} from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";

const SESSION_KEY_NAME = "evisaflow.session.key.v1";
const SESSION_DIRECTORY_NAME = "evisaflow-session";
const SESSION_FILE_NAME = "session.v1.enc";
const SESSION_TEMP_FILE_NAME = "session.v1.tmp";

type SessionDocument = Record<string, string>;

let writeQueue: Promise<void> = Promise.resolve();

function secureStoreOptions(): SecureStore.SecureStoreOptions {
  return { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
}

function sessionDirectory(): Directory {
  return new Directory(Paths.document, SESSION_DIRECTORY_NAME);
}

function sessionFile(): File {
  return new File(sessionDirectory(), SESSION_FILE_NAME);
}

export async function resetEncryptedSessionStorage(): Promise<void> {
  await writeQueue.catch(() => undefined);
  await SecureStore.deleteItemAsync(SESSION_KEY_NAME, secureStoreOptions());
  const directory = sessionDirectory();
  if (directory.exists) directory.delete();
  writeQueue = Promise.resolve();
}

async function loadKey(): Promise<AESEncryptionKey | null> {
  const encoded = await SecureStore.getItemAsync(SESSION_KEY_NAME, secureStoreOptions());
  return encoded ? AESEncryptionKey.import(encoded, "hex") : null;
}

async function getOrCreateKey(): Promise<AESEncryptionKey> {
  const existing = await loadKey();
  if (existing) return existing;
  if (!(await SecureStore.isAvailableAsync())) {
    throw new Error("Secure device storage is unavailable.");
  }
  const key = await AESEncryptionKey.generate();
  await SecureStore.setItemAsync(
    SESSION_KEY_NAME,
    await key.encoded("hex"),
    secureStoreOptions()
  );
  return key;
}

async function readDocument(): Promise<SessionDocument> {
  const file = sessionFile();
  if (!file.exists) return {};
  const key = await loadKey();
  if (!key) {
    throw new Error("The encrypted session key is unavailable.");
  }
  const sealed = AESSealedData.fromCombined(await file.bytes());
  const decoded = new TextDecoder().decode(await aesDecryptAsync(sealed, key));
  const value: unknown = JSON.parse(decoded);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The encrypted session is invalid.");
  }
  for (const entry of Object.values(value)) {
    if (typeof entry !== "string") {
      throw new Error("The encrypted session is invalid.");
    }
  }
  return value as SessionDocument;
}

async function writeDocument(document: SessionDocument): Promise<void> {
  const key = await getOrCreateKey();
  const sealed = await aesEncryptAsync(
    new TextEncoder().encode(JSON.stringify(document)),
    key
  );
  const directory = sessionDirectory();
  if (!directory.exists) directory.create({ idempotent: true, intermediates: true });
  const temporary = new File(directory, SESSION_TEMP_FILE_NAME);
  try {
    temporary.create({ overwrite: true });
    temporary.write(await sealed.combined());
    await temporary.move(sessionFile(), { overwrite: true });
  } catch (error) {
    if (temporary.exists) temporary.delete();
    throw error;
  }
}

function enqueueWrite(update: (document: SessionDocument) => SessionDocument) {
  const operation = writeQueue
    .catch(() => undefined)
    .then(async () => writeDocument(update(await readDocument())));
  writeQueue = operation.catch(() => undefined);
  return operation;
}

export const encryptedSessionStorage = {
  async getItem(key: string): Promise<string | null> {
    await writeQueue.catch(() => undefined);
    return (await readDocument())[key] ?? null;
  },
  setItem(key: string, value: string): Promise<void> {
    return enqueueWrite((document) => ({ ...document, [key]: value }));
  },
  removeItem(key: string): Promise<void> {
    return enqueueWrite((document) => {
      const next = { ...document };
      delete next[key];
      return next;
    });
  },
};
