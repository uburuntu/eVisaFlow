import { Directory, File, Paths } from "expo-file-system";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import type { SavedArtifact } from "./vault";
import { readResultArtifact } from "./vault";

const TEMP_DIRECTORY_NAME = "evisaflow-open";

export async function shareSavedArtifact(artifact: SavedArtifact): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("File sharing is unavailable on this device.");
  }
  await withTemporaryArtifact(artifact, (file) =>
    Sharing.shareAsync(file.uri, {
      mimeType: artifact.contentType,
      dialogTitle: `Share ${artifact.filename}`,
    })
  );
}

export async function printSavedArtifact(artifact: SavedArtifact): Promise<void> {
  if (artifact.contentType !== "application/pdf") {
    throw new Error("Only PDF files can be printed.");
  }
  await withTemporaryArtifact(artifact, (file) => Print.printAsync({ uri: file.uri }));
}

async function withTemporaryArtifact<T>(
  artifact: SavedArtifact,
  action: (file: File) => Promise<T>
): Promise<T> {
  const directory = new Directory(Paths.cache, TEMP_DIRECTORY_NAME);
  if (!directory.exists) directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, safeFilename(artifact.filename));
  try {
    file.create({ overwrite: true });
    file.write(await readResultArtifact(artifact));
    return await action(file);
  } finally {
    if (file.exists) file.delete();
  }
}

function safeFilename(filename: string): string {
  const sanitized = Array.from(filename, (character) =>
    character.charCodeAt(0) < 32 ? "_" : character
  )
    .join("")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180);
  return sanitized || "eVisaFlow document";
}
