/// <reference types="vitest/config" />
import { createRequire } from "node:module";
import { getViteConfig } from "astro/config";

/**
 * Vitest configuration, wired through Astro's `getViteConfig` so tests run with
 * the same Vite resolution/plugins as the app (path aliases, `.astro` handling).
 *
 * Unit-tested surfaces: the framework-agnostic API client (`src/lib/api.ts`), the
 * in-browser vault crypto (`src/crypto/vault.ts` — keypair seal/open, Argon2id
 * determinism, key wrap/unwrap, the recovery kit, and the "EVA1" sealed-artifact
 * envelope that must stay byte-compatible with `service/src/crypto/seal.ts`), the
 * member-secret seal/open round-trip, the SSE byte-decode contract, and the hash
 * router.
 *
 * libsodium resolution: the vault uses `libsodium-wrappers-sumo` (Argon2id
 * `crypto_pwhash` is sumo-only). That sumo build ships a broken ESM entry whose
 * `.mjs` does a sibling `import "./libsodium.mjs"` that mis-resolves under pnpm's
 * non-hoisted layout (the same breakage `service/src/crypto/seal.ts` documents and
 * dodges with `createRequire`). Under Vitest's Node runtime that import throws, so
 * we ALIAS the package to its working CommonJS entry (its own `require`
 * condition). The app's browser build is unaffected — Vite bundles the WASM there;
 * this alias only steers the Node test runtime to the build that loads cleanly.
 * Byte output is identical between the ESM and CJS builds.
 */
const require = createRequire(import.meta.url);
const libsodiumCjs = require.resolve("libsodium-wrappers-sumo");

export default getViteConfig({
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    environment: "node",
  },
  resolve: {
    alias: {
      "libsodium-wrappers-sumo": libsodiumCjs,
    },
  },
});
