/**
 * The vault gate: the first thing the app island shows until a key pair is held
 * in memory. Two modes, chosen by whether the user already has a vault:
 *
 *   - SETUP (no vault yet): choose a passphrase (confirmed), `createVault` in the
 *     browser, POST the opaque blobs to `/api/vault`, then show the RECOVERY KIT
 *     exactly once and force the user to acknowledge they have saved it before
 *     entering the app. The passphrase and private key never leave the browser.
 *   - UNLOCK (vault exists): enter the passphrase, GET the wrapped blobs, unwrap
 *     in memory. A wrong passphrase fails the unwrap locally (no server round
 *     trip reveals anything). A "use recovery code" path unlocks via the kit when
 *     the passphrase is lost.
 *
 * On success the unlocked key pair is handed to the vault context; this component
 * never stores it itself.
 */
import type * as React from "react";
import { type ReactElement, type ReactNode, useState } from "react";
import {
  ApiError,
  getVault,
  putVault,
  type VaultResponse,
  type VaultUploadBody,
} from "../lib/api-client.js";
import {
  type CreateVaultResult,
  createVault,
  recoverVault,
  unlockVault,
  type VaultBlobs,
  type VaultKdfParamsJson,
} from "../runtime/sodium.js";
import { useVault } from "../runtime/vault-context.js";
import { Banner, Button, Field, TextInput } from "../ui/primitives.js";

/** Minimum passphrase length. Generous lower bound; the recovery kit is the real backstop. */
const MIN_PASSPHRASE = 10;

/** Whether the user has a vault yet decides which flow renders. */
export function VaultGate({ hasVault }: { hasVault: boolean }): ReactElement {
  return hasVault ? <UnlockFlow /> : <SetupFlow />;
}

/** Maps the {@link CreateVaultResult} blobs to the vault upload body. */
function toUploadBody(result: CreateVaultResult): VaultUploadBody {
  const { blobs } = result;
  return {
    publicKey: blobs.publicKey,
    wrappedPrivateKey: blobs.wrappedPrivateKey,
    kdfSalt: blobs.kdfSalt,
    kdfParams: blobs.kdfParams,
    recoveryWrappedKey: blobs.recoveryWrappedKey,
  };
}

/** First-time setup: choose a passphrase, create + upload the vault, show the kit. */
function SetupFlow(): ReactElement {
  const { unlock } = useVault();
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreateVaultResult | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    if (passphrase.length < MIN_PASSPHRASE) {
      setError(`Use at least ${MIN_PASSPHRASE} characters.`);
      return;
    }
    if (passphrase !== confirm) {
      setError("The two passphrases do not match.");
      return;
    }
    setBusy(true);
    try {
      // All crypto is local; the server only ever sees the opaque blobs.
      const result = await createVault(passphrase);
      await putVault(toUploadBody(result));
      // Hold the kit (incl. one-time recovery code) for the acknowledgement step.
      setCreated(result);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? "Could not save your vault. Please try again."
          : "Something went wrong setting up your vault. Please try again."
      );
    } finally {
      setBusy(false);
      // Clear the confirm copy; the passphrase is dropped once the kit is shown.
      setConfirm("");
    }
  }

  if (created) {
    return (
      <RecoveryKit
        recoveryCode={created.recoveryCode}
        onAcknowledge={() => {
          // Enter the app with the in-memory key pair from setup — no re-unlock.
          unlock(created.keyPair);
        }}
      />
    );
  }

  return (
    <GateShell
      eyebrow="Set up your vault"
      title="Create your encryption passphrase"
      intro="Your documents are encrypted on this device with a passphrase only you know. We never see it, and we cannot reset it — so you'll get a one-time recovery code on the next screen. Keep it somewhere safe."
    >
      <form className="stack" onSubmit={onSubmit} noValidate>
        {error ? <Banner tone="error">{error}</Banner> : null}
        <Field
          label="Passphrase"
          required
          hint={`At least ${MIN_PASSPHRASE} characters. A memorable phrase works well.`}
        >
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              describedBy={describedBy}
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              required
            />
          )}
        </Field>
        <Field label="Confirm passphrase" required>
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              describedBy={describedBy}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          )}
        </Field>
        <Button type="submit" loading={busy} block>
          Create vault
        </Button>
      </form>
    </GateShell>
  );
}

/**
 * The one-time recovery kit. Shows the high-entropy recovery code, offers a copy
 * button, and forces an explicit "I've saved it" checkbox before the user can
 * continue — because the code is never shown again and is the only way back in if
 * the passphrase is forgotten.
 */
function RecoveryKit({
  recoveryCode,
  onAcknowledge,
}: {
  recoveryCode: string;
  onAcknowledge: () => void;
}): ReactElement {
  const [acked, setAcked] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(recoveryCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard can be blocked; the code is visible to copy manually.
      setCopied(false);
    }
  }

  return (
    <GateShell
      eyebrow="Save your recovery code"
      title="This is your only recovery code"
      intro="If you ever forget your passphrase, this code is the only way to recover your encrypted data. We do not store it and cannot show it again. Write it down or save it in a password manager now."
    >
      <div className="stack">
        <Banner tone="info">
          Treat this like a key to a safe. Anyone with it can unlock your data.
        </Banner>
        <div className="recovery-code">
          <code className="recovery-code__value">{recoveryCode}</code>
          <Button variant="ghost" onClick={copy} aria-live="polite">
            {copied ? "Copied" : "Copy code"}
          </Button>
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={acked}
            onChange={(e) => setAcked(e.target.checked)}
          />
          <span>I have saved my recovery code somewhere safe.</span>
        </label>
        <Button block disabled={!acked} onClick={onAcknowledge}>
          Continue to the app
        </Button>
      </div>
    </GateShell>
  );
}

/** Returning user: unlock the existing vault with the passphrase (or recovery code). */
function UnlockFlow(): ReactElement {
  const { unlock } = useVault();
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    if (passphrase.length === 0) {
      setError(useRecovery ? "Enter your recovery code." : "Enter your passphrase.");
      return;
    }
    setBusy(true);
    try {
      const vault = await getVault();
      if (!vault) {
        // The vault vanished (deleted elsewhere). Reload to re-evaluate setup.
        setError("No vault found for your account. Please refresh and set one up.");
        return;
      }
      const blobs = toBlobs(vault);
      // A wrong passphrase/code throws here (the secretbox fails to authenticate)
      // — caught below and shown as a local error; the server learns nothing.
      const keyPair = useRecovery
        ? await recoverVault(passphrase, blobs)
        : await unlockVault(passphrase, blobs);
      unlock(keyPair);
    } catch (err) {
      if (err instanceof ApiError) {
        setError("Could not reach your vault. Please try again.");
      } else {
        setError(
          useRecovery
            ? "That recovery code did not work. Check it and try again."
            : "That passphrase did not work. Check it and try again."
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <GateShell
      eyebrow="Unlock"
      title="Unlock your vault"
      intro="Enter your passphrase to decrypt your data on this device. It never leaves your browser."
    >
      <form className="stack" onSubmit={onSubmit} noValidate>
        {error ? <Banner tone="error">{error}</Banner> : null}
        <Field label={useRecovery ? "Recovery code" : "Passphrase"} required>
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              describedBy={describedBy}
              type={useRecovery ? "text" : "password"}
              autoComplete={useRecovery ? "off" : "current-password"}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              required
            />
          )}
        </Field>
        <Button type="submit" loading={busy} block>
          Unlock
        </Button>
        <button
          type="button"
          className="linklike"
          onClick={() => {
            setUseRecovery((v) => !v);
            setPassphrase("");
            setError(null);
          }}
        >
          {useRecovery
            ? "Use my passphrase instead"
            : "Forgot your passphrase? Use your recovery code"}
        </button>
      </form>
    </GateShell>
  );
}

/** Adapts the API vault response to the crypto module's {@link VaultBlobs} shape. */
function toBlobs(vault: VaultResponse): VaultBlobs {
  return {
    publicKey: vault.publicKey,
    wrappedPrivateKey: vault.wrappedPrivateKey,
    kdfSalt: vault.kdfSalt,
    // The vault module reads opslimit/memlimit/alg (+ embedded recovery) off
    // this; the server stored it verbatim as JSON, so the shape round-trips. It
    // is `unknown` over the wire, narrowed back to the params JSON here.
    kdfParams: vault.kdfParams as VaultKdfParamsJson,
    recoveryWrappedKey: vault.recoveryWrappedKey ?? undefined,
  };
}

/** Shared centered layout for every gate step. */
function GateShell({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="gate">
      <div className="gate__panel card card--feature stack">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="gate__title">{title}</h1>
        <p className="lead">{intro}</p>
        {children}
      </div>
    </div>
  );
}
