import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Download } from "playwright";

const PDF_MAGIC = Buffer.from("%PDF-", "ascii");

const isWithinDirectory = (directory: string, path: string): boolean => {
  const relativePath = relative(directory, path);
  return (
    relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
};

export const resolveOutputPath = (
  outputDir: string,
  outputFile: string | undefined,
  defaultFilename: string
): string => {
  const resolvedDir = resolve(outputDir);
  const filename = outputFile ? outputFile : join(resolvedDir, defaultFilename);

  const resolvedFilename = resolve(filename);
  if (!outputFile && !isWithinDirectory(resolvedDir, resolvedFilename)) {
    throw new Error(
      `Output path "${outputFile}" resolves outside output directory "${outputDir}"`
    );
  }
  return resolvedFilename;
};

export const ensureParentDirectory = async (path: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
};

export const assertPdfBytes = (bytes: Uint8Array): void => {
  if (bytes.byteLength === 0) {
    throw new Error("Downloaded PDF was empty");
  }
  if (!Buffer.from(bytes.subarray(0, PDF_MAGIC.byteLength)).equals(PDF_MAGIC)) {
    throw new Error("Downloaded file did not look like a PDF");
  }
};

export const readDownloadBytes = async (
  download: Download,
  maxBytes: number
): Promise<Uint8Array> => {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error(`Downloaded PDF exceeded configured max size of ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }

  const bytes = Buffer.concat(chunks, totalBytes);
  assertPdfBytes(bytes);
  return bytes;
};

export const saveDownloadPdf = async (
  download: Download,
  path: string,
  maxBytes: number
): Promise<void> => {
  let bytes: Uint8Array;
  try {
    bytes = await readDownloadBytes(download, maxBytes);
  } finally {
    await download.delete().catch(() => {});
  }
  await writeFile(path, bytes);
};
