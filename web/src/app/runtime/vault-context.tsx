/**
 * In-memory vault state for the app island.
 *
 * SECURITY: the unlocked X25519 key pair (and the passphrase used to derive it)
 * NEVER leave the browser and are NEVER persisted. They live only in this
 * provider's React state for the lifetime of the tab. We zero the private key and
 * drop the reference on explicit lock and on `pagehide` (covers tab close,
 * navigation, and bfcache on mobile Safari where `beforeunload` is unreliable),
 * so a closed/locked tab holds no key material. Nothing here writes to
 * localStorage/sessionStorage/IndexedDB.
 *
 * The context exposes the unlocked `keyPair` (or null when locked), a `unlock`
 * setter the vault gate calls after a successful unwrap, and `lock()`.
 */
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BoxKeyPair } from "./sodium.js";

interface VaultContextValue {
  /** The unlocked key pair, or null when the vault is locked. */
  keyPair: BoxKeyPair | null;
  /** True when a key pair is held in memory. */
  isUnlocked: boolean;
  /** Records the unlocked key pair in memory (called after a successful unwrap). */
  unlock: (keyPair: BoxKeyPair) => void;
  /** Zeroes and drops the key material. Safe to call when already locked. */
  lock: () => void;
}

const VaultContext = createContext<VaultContextValue | null>(null);

/** Best-effort wipe of a private key buffer before dropping the reference. */
function zeroKey(keyPair: BoxKeyPair | null): void {
  if (keyPair) keyPair.privateKey.fill(0);
}

export function VaultProvider({ children }: { children: ReactNode }): ReactElement {
  const [keyPair, setKeyPair] = useState<BoxKeyPair | null>(null);
  // A ref mirrors state so the unload handler (registered once) always sees the
  // current key without re-subscribing on every unlock/lock.
  const keyRef = useRef<BoxKeyPair | null>(null);
  keyRef.current = keyPair;

  const lock = useCallback(() => {
    zeroKey(keyRef.current);
    keyRef.current = null;
    setKeyPair(null);
  }, []);

  const unlock = useCallback((next: BoxKeyPair) => {
    setKeyPair(next);
  }, []);

  // Drop key material when the tab goes away. `pagehide` fires on close,
  // navigation, and when entering the bfcache (where `beforeunload` may not), so
  // it is the most reliable single hook for "this tab is no longer in use".
  useEffect(() => {
    const onHide = (): void => {
      zeroKey(keyRef.current);
      keyRef.current = null;
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  const value = useMemo<VaultContextValue>(
    () => ({ keyPair, isUnlocked: keyPair !== null, unlock, lock }),
    [keyPair, unlock, lock]
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

/** Accessor for the vault context; throws if used outside the provider. */
export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error("useVault must be used within a VaultProvider");
  return ctx;
}
