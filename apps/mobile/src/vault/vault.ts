import { type MobileProfile, MobileProfileSchema } from "@evisa-flow/protocol";
import {
  AESEncryptionKey,
  AESSealedData,
  aesDecryptAsync,
  aesEncryptAsync,
} from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { z } from "zod";

const VAULT_KEY_NAME = "evisaflow.vault.key.v1";
const VAULT_DIRECTORY_NAME = "evisaflow-vault";
const VAULT_FILE_NAME = "manifest.v1.enc";
const VAULT_TEMP_FILE_NAME = "manifest.v1.tmp";

const VaultDocumentSchema = z.object({
  version: z.literal(1),
  acceptedDisclosureAt: z.iso.datetime().nullable(),
  acceptedTermsVersion: z.string().nullable(),
  profiles: z.array(MobileProfileSchema).max(6),
});

export type VaultDocument = z.infer<typeof VaultDocumentSchema>;

export class VaultUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VaultUnavailableError";
  }
}

export class VaultCorruptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VaultCorruptError";
  }
}

export function createEmptyVault(): VaultDocument {
  return {
    version: 1,
    acceptedDisclosureAt: null,
    acceptedTermsVersion: null,
    profiles: [],
  };
}

function getVaultDirectory(): Directory {
  return new Directory(Paths.document, VAULT_DIRECTORY_NAME);
}

function getVaultFile(): File {
  return new File(getVaultDirectory(), VAULT_FILE_NAME);
}

function secureStoreOptions(): SecureStore.SecureStoreOptions {
  return {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };
}

async function loadKey(): Promise<AESEncryptionKey | null> {
  const encodedKey = await SecureStore.getItemAsync(VAULT_KEY_NAME, secureStoreOptions());

  if (!encodedKey) {
    return null;
  }

  return AESEncryptionKey.import(encodedKey, "hex");
}

async function getOrCreateKey(): Promise<AESEncryptionKey> {
  const existingKey = await loadKey();
  if (existingKey) {
    return existingKey;
  }

  if (!(await SecureStore.isAvailableAsync())) {
    throw new VaultUnavailableError("Secure device storage is unavailable.");
  }

  const key = await AESEncryptionKey.generate();
  const encodedKey = await key.encoded("hex");
  await SecureStore.setItemAsync(VAULT_KEY_NAME, encodedKey, secureStoreOptions());
  return key;
}

export async function loadVault(): Promise<VaultDocument> {
  const file = getVaultFile();
  if (!file.exists) {
    return createEmptyVault();
  }

  const key = await loadKey();
  if (!key) {
    throw new VaultUnavailableError(
      "The encrypted vault exists, but its device key is no longer available."
    );
  }

  try {
    const encryptedBytes = await file.bytes();
    const sealedData = AESSealedData.fromCombined(encryptedBytes);
    const plaintextBytes = await aesDecryptAsync(sealedData, key);
    const parsed = JSON.parse(new TextDecoder().decode(plaintextBytes));
    return VaultDocumentSchema.parse(parsed);
  } catch (error) {
    throw new VaultCorruptError("The encrypted vault could not be opened.", {
      cause: error,
    });
  }
}

export async function saveVault(document: VaultDocument): Promise<void> {
  const validatedDocument = VaultDocumentSchema.parse(document);
  const key = await getOrCreateKey();
  const plaintextBytes = new TextEncoder().encode(JSON.stringify(validatedDocument));
  const sealedData = await aesEncryptAsync(plaintextBytes, key);
  const encryptedBytes = await sealedData.combined();

  const directory = getVaultDirectory();
  if (!directory.exists) {
    directory.create({ idempotent: true, intermediates: true });
  }

  const file = getVaultFile();
  const temporaryFile = new File(directory, VAULT_TEMP_FILE_NAME);

  try {
    temporaryFile.create({ overwrite: true });
    temporaryFile.write(encryptedBytes);
    await temporaryFile.move(file, { overwrite: true });
  } catch (error) {
    if (temporaryFile.exists) {
      temporaryFile.delete();
    }
    throw error;
  }
}

export async function resetVault(): Promise<VaultDocument> {
  await SecureStore.deleteItemAsync(VAULT_KEY_NAME, secureStoreOptions());

  const directory = getVaultDirectory();
  if (directory.exists) {
    directory.delete();
  }

  return createEmptyVault();
}

export function validateProfile(profile: MobileProfile): MobileProfile {
  return MobileProfileSchema.parse(profile);
}
