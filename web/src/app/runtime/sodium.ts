/**
 * libsodium runtime, loaded ONLY from inside the React app island.
 *
 * Importing `../../crypto/vault` (which imports `libsodium-wrappers`) anywhere in
 * this island pulls the WASM into the island's bundle and nowhere else: the
 * marketing/login pages never touch it, so a visitor reading `/security` ships
 * zero crypto bytes. Every screen awaits {@link ensureSodium} once (via the
 * vault context) before calling a vault primitive, so the rest of the island can
 * treat the synchronous `vault` helpers as ready.
 *
 * This module deliberately re-exports the vault surface the island uses so every
 * crypto call funnels through one place — making it obvious in review that the
 * passphrase and private key never leave the browser.
 */
import { ready } from "../../crypto/vault.js";

export * from "../../crypto/vault.js";

let initialised: Promise<void> | undefined;

/**
 * Initialises the libsodium WASM runtime exactly once. Idempotent and safe to
 * call from every screen on mount; subsequent calls await the same promise. Must
 * resolve before any other vault helper is used.
 */
export function ensureSodium(): Promise<void> {
  if (!initialised) {
    initialised = ready().then(() => undefined);
  }
  return initialised;
}
