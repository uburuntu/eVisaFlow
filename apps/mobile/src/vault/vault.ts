import {
  type MobileArtifactDescriptor,
  MobileArtifactDescriptorSchema,
  type MobileProfile,
  MobileProfileSchema,
  type Purpose,
  PurposeSchema,
  ShareCodeValidUntilSchema,
} from "@evisa-flow/protocol";
import {
  AESEncryptionKey,
  AESSealedData,
  aesDecryptAsync,
  aesEncryptAsync,
  CryptoDigestAlgorithm,
  digest,
} from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { z } from "zod";

const VAULT_KEY_NAME = "evisaflow.vault.key.v1";
const VAULT_DIRECTORY_NAME = "evisaflow-vault";
const VAULT_FILE_NAME = "manifest.v1.enc";
const VAULT_TEMP_FILE_NAME = "manifest.v1.tmp";
const ARTIFACT_DIRECTORY_NAME = "artifacts";
const STAGING_PREFIX = ".staging-";
const IsoDateTimeSchema = z.iso.datetime({ offset: true });

const SavedArtifactSchema = MobileArtifactDescriptorSchema.extend({
  encryptedPath: z.string().regex(/^[0-9a-f-]+\/[0-9a-f-]+\.enc$/),
});

const SavedResultSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  profileId: z.uuid(),
  purpose: PurposeSchema,
  shareCode: z.string().trim().min(1).max(32),
  validUntil: ShareCodeValidUntilSchema.optional(),
  generatedAt: IsoDateTimeSchema.optional(),
  savedAt: IsoDateTimeSchema,
  artifacts: z.array(SavedArtifactSchema),
});

const ActiveRunSchema = z.object({
  id: z.uuid(),
  profileId: z.uuid(),
  purpose: PurposeSchema,
  createdAt: IsoDateTimeSchema,
});

const PendingClaimAcknowledgementSchema = z.object({
  runId: z.uuid(),
  resultId: z.uuid(),
  claimToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: IsoDateTimeSchema,
});

const VaultPreferencesSchema = z.object({
  expiryRemindersEnabled: z.boolean().default(false),
});

const VaultDocumentSchema = z.object({
  version: z.literal(1),
  acceptedDisclosureAt: IsoDateTimeSchema.nullable(),
  acceptedTermsVersion: z.string().nullable(),
  profiles: z.array(MobileProfileSchema).max(6),
  results: z.array(SavedResultSchema).max(100).default([]),
  activeRuns: z.array(ActiveRunSchema).max(1).default([]),
  pendingClaimAcknowledgements: z
    .array(PendingClaimAcknowledgementSchema)
    .max(3)
    .default([]),
  profileSlotTombstones: z.array(z.uuid()).max(100).default([]),
  preferences: VaultPreferencesSchema.default({ expiryRemindersEnabled: false }),
});

export type VaultDocument = z.infer<typeof VaultDocumentSchema>;
export type SavedResult = z.infer<typeof SavedResultSchema>;
export type SavedArtifact = z.infer<typeof SavedArtifactSchema>;
export type ActiveRun = z.infer<typeof ActiveRunSchema>;
export type PendingClaimAcknowledgement = z.infer<
  typeof PendingClaimAcknowledgementSchema
>;
export type VaultPreferences = z.infer<typeof VaultPreferencesSchema>;

export interface TrackRunInput {
  id: string;
  profileId: string;
  purpose: Purpose;
  createdAt: string;
}

export interface SaveResultInput {
  id: string;
  runId: string;
  profileId: string;
  purpose: SavedResult["purpose"];
  shareCode: string;
  validUntil?: string;
  generatedAt: string;
  claim: {
    claimToken: string;
    manifestHash: string;
  };
  artifacts: Array<{
    descriptor: MobileArtifactDescriptor;
    bytes: Uint8Array;
  }>;
}

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
    results: [],
    activeRuns: [],
    pendingClaimAcknowledgements: [],
    profileSlotTombstones: [],
    preferences: { expiryRemindersEnabled: false },
  };
}

function getVaultDirectory(): Directory {
  return new Directory(Paths.document, VAULT_DIRECTORY_NAME);
}

function getVaultFile(): File {
  return new File(getVaultDirectory(), VAULT_FILE_NAME);
}

function getArtifactDirectory(): Directory {
  return new Directory(getVaultDirectory(), ARTIFACT_DIRECTORY_NAME);
}

function getResultDirectory(resultId: string): Directory {
  return new Directory(getArtifactDirectory(), resultId);
}

function getArtifactFile(encryptedPath: string): File {
  return new File(getArtifactDirectory(), ...encryptedPath.split("/"));
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

  let document: VaultDocument;
  try {
    const encryptedBytes = await file.bytes();
    const sealedData = AESSealedData.fromCombined(encryptedBytes);
    const plaintextBytes = await aesDecryptAsync(sealedData, key);
    const parsed = JSON.parse(new TextDecoder().decode(plaintextBytes));
    document = VaultDocumentSchema.parse(parsed);
  } catch (error) {
    throw new VaultCorruptError("The encrypted vault could not be opened.", {
      cause: error,
    });
  }

  try {
    cleanupUnreferencedArtifactDirectories(document);
  } catch {
    // Cleanup is retried on the next load and must never block valid encrypted data.
  }
  return document;
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

export async function persistResult(input: SaveResultInput): Promise<SavedResult> {
  const key = await getOrCreateKey();
  const resultDirectory = getResultDirectory(input.id);
  const stagingDirectory = new Directory(
    getArtifactDirectory(),
    `${STAGING_PREFIX}${input.id}`
  );
  if (resultDirectory.exists) {
    resultDirectory.delete();
  }
  if (stagingDirectory.exists) stagingDirectory.delete();
  stagingDirectory.create({ idempotent: true, intermediates: true });

  try {
    const artifacts: SavedArtifact[] = [];
    for (const artifact of input.artifacts) {
      if (artifact.bytes.byteLength !== artifact.descriptor.byteLength) {
        throw new VaultCorruptError(
          "Downloaded artifact size does not match its manifest."
        );
      }

      const hashInput = new Uint8Array(new ArrayBuffer(artifact.bytes.byteLength));
      hashInput.set(artifact.bytes);
      const actualSha256 = bytesToHex(
        new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, hashInput))
      );
      if (actualSha256 !== artifact.descriptor.sha256.toLowerCase()) {
        throw new VaultCorruptError(
          "Downloaded artifact hash does not match its manifest."
        );
      }

      const sealedData = await aesEncryptAsync(artifact.bytes, key);
      const encryptedBytes = await sealedData.combined();
      const encryptedPath = `${input.id}/${artifact.descriptor.id}.enc`;
      const file = new File(stagingDirectory, `${artifact.descriptor.id}.enc`);
      file.create({ overwrite: true, intermediates: true });
      file.write(encryptedBytes);
      const readBack = await aesDecryptAsync(
        AESSealedData.fromCombined(await file.bytes()),
        key
      );
      if (!bytesEqual(readBack, artifact.bytes)) {
        throw new VaultCorruptError("Encrypted artifact read-back did not match.");
      }
      artifacts.push(
        SavedArtifactSchema.parse({
          ...artifact.descriptor,
          encryptedPath,
        })
      );
    }

    const savedResult = SavedResultSchema.parse({
      id: input.id,
      runId: input.runId,
      profileId: input.profileId,
      purpose: input.purpose,
      shareCode: input.shareCode,
      validUntil: input.validUntil,
      generatedAt: input.generatedAt,
      savedAt: new Date().toISOString(),
      artifacts,
    });
    await stagingDirectory.move(resultDirectory);
    return savedResult;
  } catch (error) {
    if (stagingDirectory.exists) {
      stagingDirectory.delete();
    }
    if (resultDirectory.exists) {
      resultDirectory.delete();
    }
    throw error;
  }
}

export async function readResultArtifact(artifact: SavedArtifact): Promise<Uint8Array> {
  const key = await loadKey();
  if (!key) {
    throw new VaultUnavailableError("The artifact encryption key is unavailable.");
  }
  const file = getArtifactFile(artifact.encryptedPath);
  if (!file.exists) {
    throw new VaultCorruptError("The encrypted artifact file is missing.");
  }
  try {
    const sealedData = AESSealedData.fromCombined(await file.bytes());
    return await aesDecryptAsync(sealedData, key);
  } catch (error) {
    throw new VaultCorruptError("The encrypted artifact could not be opened.", {
      cause: error,
    });
  }
}

export function deleteResultArtifacts(resultIds: string[]): void {
  for (const resultId of resultIds) {
    const directory = getResultDirectory(resultId);
    if (directory.exists) {
      directory.delete();
    }
  }
}

export async function moveResultArtifactsToTrash(
  resultId: string
): Promise<Directory | null> {
  const source = getResultDirectory(resultId);
  if (!source.exists) return null;
  const trash = new Directory(
    getArtifactDirectory(),
    `${STAGING_PREFIX}delete-${resultId}`
  );
  if (trash.exists) trash.delete();
  await source.move(trash);
  return trash;
}

export async function restoreResultArtifactsFromTrash(
  resultId: string,
  trash: Directory | null
): Promise<void> {
  if (!trash?.exists) return;
  await trash.move(getResultDirectory(resultId));
}

function cleanupUnreferencedArtifactDirectories(document: VaultDocument): void {
  const directory = getArtifactDirectory();
  if (!directory.exists) return;
  const expected = new Set(document.results.map((result) => result.id));
  for (const entry of directory.list()) {
    if (entry instanceof Directory && !expected.has(entry.name)) {
      entry.delete();
    }
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function validateProfile(profile: MobileProfile): MobileProfile {
  return MobileProfileSchema.parse(profile);
}
