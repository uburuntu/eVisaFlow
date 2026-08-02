import type { MobileArtifactDescriptor } from "./types.js";

export interface MobileClaimManifestInput {
  runId: string;
  shareCode: string;
  validUntil?: string;
  generatedAt: string;
  artifacts: MobileArtifactDescriptor[];
}

export function mobileClaimManifestJson(input: MobileClaimManifestInput): string {
  return JSON.stringify({
    runId: input.runId,
    shareCode: input.shareCode,
    validUntil: input.validUntil ?? null,
    generatedAt: input.generatedAt,
    artifacts: [...input.artifacts]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        filename: artifact.filename,
        contentType: artifact.contentType,
        byteLength: artifact.byteLength,
        sha256: artifact.sha256,
      })),
  });
}
