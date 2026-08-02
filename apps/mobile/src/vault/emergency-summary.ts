import type { MobileProfile } from "@evisa-flow/protocol";
import { Directory, File, Paths } from "expo-file-system";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { emergencySummaryHtml } from "./emergency-summary-html";
import type { SavedResult } from "./vault";

interface SummaryItem {
  profile?: MobileProfile;
  result: SavedResult;
}

const SUMMARY_DIRECTORY_NAME = "evisaflow-summary";

export function cleanupTemporaryEmergencySummaries(): void {
  const directory = new Directory(Paths.cache, SUMMARY_DIRECTORY_NAME);
  if (directory.exists) directory.delete();
}

export async function shareEmergencySummary(items: SummaryItem[]): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("File sharing is unavailable on this device.");
  }
  await withEmergencySummary(items, (uri) =>
    Sharing.shareAsync(uri, {
      mimeType: "application/pdf",
      dialogTitle: "Share eVisaFlow offline summary",
      UTI: "com.adobe.pdf",
    })
  );
}

export async function printEmergencySummary(items: SummaryItem[]): Promise<void> {
  await withEmergencySummary(items, (uri) => Print.printAsync({ uri }));
}

async function withEmergencySummary<T>(
  items: SummaryItem[],
  action: (uri: string) => Promise<T>
): Promise<T> {
  if (items.length === 0) throw new Error("Select at least one saved proof.");
  const output = await Print.printToFileAsync({ html: emergencySummaryHtml(items) });
  const source = new File(output.uri);
  const directory = new Directory(Paths.cache, SUMMARY_DIRECTORY_NAME);
  if (!directory.exists) directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, "eVisaFlow Offline Summary.pdf");
  try {
    await source.move(file, { overwrite: true });
    return await action(file.uri);
  } finally {
    if (file.exists) file.delete();
    if (source.exists) source.delete();
  }
}
