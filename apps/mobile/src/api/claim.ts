import {
  type MobileRunClaimSession,
  mobileClaimManifestJson,
} from "@evisa-flow/protocol";
import { CryptoDigestAlgorithm, digest } from "expo-crypto";

export async function mobileClaimManifestHash(
  runId: string,
  session: Pick<
    MobileRunClaimSession,
    "shareCode" | "validUntil" | "generatedAt" | "artifacts"
  >
): Promise<string> {
  const bytes = new TextEncoder().encode(mobileClaimManifestJson({ runId, ...session }));
  const hash = new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
