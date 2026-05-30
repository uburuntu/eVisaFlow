/**
 * The live run screen: the end-to-end E2EE flow in one place.
 *
 *   1. Pick a person (or use the one passed via the route) and confirm the
 *      purpose + 2FA channel.
 *   2. Open that member's sealed secret locally → derive the inline applicant →
 *      POST it to `/api/runs` (plaintext in transit only, never persisted).
 *   3. Subscribe to the run's SSE timeline ({@link useRunStream}): queue position,
 *      phase, and elapsed time.
 *   4. On `challenge_required`, show a 2FA code input → POST `/api/runs/:id/code`.
 *   5. On `completed`, open the sealed share code in-browser and fetch + open each
 *      sealed artifact (eVisa PDF / checker HTML / checker PDF), offering them as
 *      download object URLs. Nothing decrypted is ever uploaded back.
 *   6. A cancel button (while active) → POST `/api/runs/:id/cancel`.
 */
import type * as React from "react";
import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  cancelRun,
  createRun,
  fetchSealedArtifact,
  listMembers,
  listRunArtifacts,
  type Member,
  submitRunCode,
} from "../lib/api-client.js";
import { formatDate, PURPOSE_LABELS, TWO_FACTOR_LABELS } from "../lib/labels.js";
import {
  applicantFromSecret,
  type MemberSecret,
  openMemberSecret,
  type Purpose,
  type TwoFactorMethod,
} from "../lib/member-secret.js";
import type { SealedArtifactRef } from "../lib/run-events.js";
import { type RunStreamState, useRunStream } from "../lib/use-run-stream.js";
import { navigate } from "../runtime/router.js";
import { bytesToString, openForSelf, openSealedArtifact } from "../runtime/sodium.js";
import { useVault } from "../runtime/vault-context.js";
import {
  Banner,
  Button,
  Field,
  LoadingState,
  Select,
  Spinner,
  TextInput,
} from "../ui/primitives.js";

interface RunScreenProps {
  /** A run already in progress (deep link / reconnect) to resume streaming. */
  runId?: string;
  /** A member to pre-select when starting a fresh run. */
  memberId?: string;
}

export function RunScreen({ runId, memberId }: RunScreenProps): ReactElement {
  // The route is the source of truth: a `runId` in the hash means "resume/stream
  // this run" (so a reload mid-run keeps streaming), otherwise show the start
  // form. Starting a run navigates to `#/run/<id>`, which flips this prop — no
  // local run-id state to drift out of sync with the URL.
  return runId ? (
    <RunProgress runId={runId} />
  ) : (
    <RunStart
      memberId={memberId}
      onStarted={(id) => navigate({ name: "run", runId: id })}
    />
  );
}

/** Step 1–2: choose options, open the secret, POST the run. */
function RunStart({
  memberId,
  onStarted,
}: {
  memberId?: string;
  onStarted: (runId: string) => void;
}): ReactElement {
  const { keyPair } = useVault();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>(memberId ?? "");
  const [purpose, setPurpose] = useState<Purpose | "">("");
  const [twoFactor, setTwoFactor] = useState<TwoFactorMethod | "">("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let active = true;
    listMembers()
      .then((rows) => {
        if (!active) return;
        setMembers(rows);
        // Default the selection to the first person only when nothing is chosen
        // yet. The functional update reads the latest value, so this effect needs
        // no dependency on `selectedId` (avoids a stale-closure re-run).
        if (rows.length > 0) {
          setSelectedId((current) => current || rows[0].id);
        }
      })
      .catch(() => {
        if (active) setError("Could not load your people. Please try again.");
      });
    return () => {
      active = false;
    };
  }, []);

  const selected = members?.find((m) => m.id === selectedId) ?? null;

  // Open the selected member's secret locally to seed defaults (purpose/2FA) and
  // to have the applicant ready at submit. Recomputed on selection/key change.
  const secret = useMemo<MemberSecret | null>(() => {
    if (!selected?.encryptedSecret || !keyPair) return null;
    try {
      return openMemberSecret(selected.encryptedSecret, keyPair);
    } catch {
      return null;
    }
  }, [selected, keyPair]);

  // Seed the purpose/2FA selects from the member's stored defaults when it loads.
  useEffect(() => {
    if (secret) {
      setPurpose((p) => (p === "" ? secret.purpose : p));
      setTwoFactor((t) => (t === "" ? secret.twoFactorMethod : t));
    }
  }, [secret]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!selected) {
      setError("Choose a person to continue.");
      return;
    }
    if (!keyPair) {
      setError("Your vault is locked. Unlock it and try again.");
      return;
    }
    if (!secret) {
      setError("This person's details could not be unlocked with your current key.");
      return;
    }
    const effectivePurpose = (purpose || secret.purpose) as Purpose;
    const effective2fa = (twoFactor || secret.twoFactorMethod) as TwoFactorMethod;

    setStarting(true);
    try {
      // Decrypt → inline applicant → POST. The applicant is sent over TLS for
      // this run only and is never persisted server-side.
      const runId = await createRun({
        memberId: selected.id,
        applicant: applicantFromSecret(secret),
        purpose: effectivePurpose,
        twoFactorMethod: effective2fa,
      });
      onStarted(runId);
    } catch (err) {
      setError(startErrorMessage(err));
      setStarting(false);
    }
  }

  if (members === null) {
    return <LoadingState label="Loading…" />;
  }

  if (members.length === 0) {
    return (
      <div className="stack-lg form-narrow">
        <PageHead title="Get a share code" />
        <Banner tone="info">
          Add a person first, then come back to generate their share code.
        </Banner>
        <Button onClick={() => navigate({ name: "add-member" })}>Add a person</Button>
      </div>
    );
  }

  return (
    <div className="stack-lg form-narrow">
      <PageHead title="Get a share code" />
      <p className="lead">
        We'll sign in to the GOV.UK eVisa service for this person and fetch a fresh share
        code. You'll enter the one-time security code they receive.
      </p>
      <form className="card stack" onSubmit={onSubmit} noValidate>
        {error ? <Banner tone="error">{error}</Banner> : null}

        <Field label="Person" required>
          {({ id }) => (
            <Select
              id={id}
              value={selectedId}
              onChange={(e) => {
                setSelectedId(e.target.value);
                setPurpose("");
                setTwoFactor("");
              }}
            >
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </Select>
          )}
        </Field>

        {selected && !secret ? (
          <Banner tone="error">
            This person's details could not be unlocked with your current key. You may
            need to unlock with the passphrase used when they were added.
          </Banner>
        ) : null}

        <Field label="Purpose" required>
          {({ id }) => (
            <Select
              id={id}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value as Purpose)}
              disabled={!secret}
            >
              {(Object.keys(PURPOSE_LABELS) as Purpose[]).map((p) => (
                <option key={p} value={p}>
                  {PURPOSE_LABELS[p]}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          label="Where the security code is sent"
          hint="Must match how this person receives codes on GOV.UK."
        >
          {({ id, describedBy }) => (
            <Select
              id={id}
              describedBy={describedBy}
              value={twoFactor}
              onChange={(e) => setTwoFactor(e.target.value as TwoFactorMethod)}
              disabled={!secret}
            >
              {(Object.keys(TWO_FACTOR_LABELS) as TwoFactorMethod[]).map((m) => (
                <option key={m} value={m}>
                  {TWO_FACTOR_LABELS[m]}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Button type="submit" loading={starting} disabled={!secret} block>
          Start
        </Button>
      </form>
    </div>
  );
}

/** Maps a createRun error to friendly copy. */
function startErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "run_already_active":
        return "A run for this person is already in progress.";
      case "no_vault":
        return "Set up your vault before starting a run.";
      case "run_not_allowed":
        return "You can't start a run right now.";
      case "member_not_found":
        return "That person could not be found. Refresh and try again.";
      default:
        return "Could not start the run. Please try again.";
    }
  }
  return "Could not start the run. Please try again.";
}

/** Steps 3–6: stream progress, collect 2FA, decrypt + offer the results. */
function RunProgress({ runId }: { runId: string }): ReactElement {
  const stream = useRunStream(runId);
  const isActive =
    stream.status === "queued" ||
    stream.status === "running" ||
    stream.status === "awaiting_2fa" ||
    stream.status === "unknown";

  return (
    <div className="stack-lg form-narrow">
      <PageHead title="Generating share code" />

      <ConnectionNote connection={stream.connection} active={isActive} />

      {stream.status !== "completed" && stream.status !== "failed" ? (
        <ProgressCard key={runId} stream={stream} />
      ) : null}

      {stream.status === "awaiting_2fa" && stream.challenge ? (
        <TwoFactorCard runId={runId} method={stream.challenge.method} />
      ) : null}

      {stream.status === "completed" && stream.completed ? (
        <ResultCard
          runId={runId}
          sealedShareCode={stream.completed.sealedShareCode}
          validUntil={stream.completed.validUntil}
          announced={stream.artifacts}
        />
      ) : null}

      {stream.status === "failed" && stream.failure ? (
        <FailureCard failure={stream.failure} />
      ) : null}

      <div className="run-footer">
        {isActive ? <CancelButton runId={runId} /> : null}
        <Button variant="ghost" onClick={() => navigate({ name: "dashboard" })}>
          Back to dashboard
        </Button>
      </div>
    </div>
  );
}

/** A subtle note about the SSE connection (reconnecting / lost). */
function ConnectionNote({
  connection,
  active,
}: {
  connection: RunStreamState["connection"];
  active: boolean;
}): ReactElement | null {
  if (!active) return null;
  if (connection === "reconnecting") {
    return <Banner tone="info">Reconnecting to the live update…</Banner>;
  }
  return null;
}

/** Queue position / phase / elapsed timer while the run is in flight. */
function ProgressCard({ stream }: { stream: RunStreamState }): ReactElement {
  const elapsed = useElapsed();
  return (
    <div className="card stack run-progress">
      <div className="run-progress__row">
        <Spinner label="Working" />
        <div>
          <p className="run-progress__phase">
            {stream.status === "queued"
              ? "Waiting in the queue"
              : stream.status === "awaiting_2fa"
                ? "Waiting for your security code"
                : (stream.phaseLabel ?? "Starting…")}
          </p>
          {stream.queue ? (
            <p className="run-progress__sub">
              Position {stream.queue.position} of {stream.queue.active} active
            </p>
          ) : (
            <p className="run-progress__sub">Elapsed {formatElapsed(elapsed)}</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Step 4: collect and submit the one-time 2FA code for the waiting run. */
function TwoFactorCard({
  runId,
  method,
}: {
  runId: string;
  method: "sms" | "email";
}): ReactElement {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      setError("Enter the code you received.");
      return;
    }
    setSubmitting(true);
    try {
      await submitRunCode(runId, trimmed);
      setSubmitted(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === "no_pending_challenge") {
        setError("That code window has closed. The run may have moved on.");
      } else {
        setError("Could not submit the code. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card card--feature stack" onSubmit={onSubmit} noValidate>
      <h2 className="card-title">Enter the security code</h2>
      <p>
        A one-time code was sent by {TWO_FACTOR_LABELS[method].toLowerCase()}. Enter it
        below to continue.
      </p>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {submitted ? (
        <Banner tone="success">Code submitted. Continuing the run…</Banner>
      ) : null}
      <Field label="Security code" required>
        {({ id, describedBy }) => (
          <TextInput
            id={id}
            describedBy={describedBy}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={submitted}
            required
          />
        )}
      </Field>
      <Button type="submit" loading={submitting} disabled={submitted} block>
        Submit code
      </Button>
    </form>
  );
}

/** Step 5: decrypt the share code + artifacts in-browser and offer downloads. */
function ResultCard({
  runId,
  sealedShareCode,
  validUntil,
  announced,
}: {
  runId: string;
  sealedShareCode?: Uint8Array;
  validUntil?: string;
  announced: SealedArtifactRef[];
}): ReactElement {
  const { keyPair } = useVault();
  const [shareCode, setShareCode] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Open the sealed share code locally once we have the bytes + the vault key.
  useEffect(() => {
    if (!keyPair) return;
    if (!sealedShareCode) {
      setShareCode(null);
      return;
    }
    try {
      // The share code is a sealed UTF-8 string (NOT an "EVA1" envelope — that
      // wrapper is only for artifacts): open with the vault key, then decode.
      const opened = openForSelf(sealedShareCode, keyPair.publicKey, keyPair.privateKey);
      setShareCode(bytesToString(opened));
    } catch {
      setShareError("Could not open the share code with your key.");
    }
  }, [sealedShareCode, keyPair]);

  async function copyShareCode(): Promise<void> {
    if (!shareCode) return;
    try {
      await navigator.clipboard.writeText(shareCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="card card--feature stack result">
      <h2 className="card-title">Your share code is ready</h2>
      {validUntil ? (
        <p className="result__validity">
          Valid until <strong>{formatDate(validUntil)}</strong>
        </p>
      ) : null}

      {shareCode ? (
        <div className="share-code">
          <code className="share-code__value">{shareCode}</code>
          <Button variant="accent" onClick={copyShareCode}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      ) : shareError ? (
        <Banner tone="error">{shareError}</Banner>
      ) : sealedShareCode ? (
        <LoadingState label="Opening your share code…" />
      ) : (
        <Banner tone="info">This run did not produce a share code.</Banner>
      )}

      <Artifacts runId={runId} announced={announced} />
    </div>
  );
}

/** Fetches, decrypts, and offers each sealed artifact as a download. */
function Artifacts({
  runId,
  announced,
}: {
  runId: string;
  announced: SealedArtifactRef[];
}): ReactElement {
  const { keyPair } = useVault();
  const [items, setItems] = useState<DecryptedArtifact[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!keyPair) return;
    let active = true;
    // URLs created by THIS run of the effect, revoked in its own cleanup so a
    // re-run (or unmount) never leaks a blob URL.
    const createdUrls: string[] = [];
    setError(null);
    setItems(null);

    (async () => {
      try {
        // The server persists sealed artifacts; list them, fetch each sealed
        // blob, and open it in-browser. The persisted list works on a reconnect
        // with no live `artifact_ready`; the announced refs only help label kind.
        const list = await listRunArtifacts(runId);
        const decrypted: DecryptedArtifact[] = [];
        for (const meta of list) {
          const sealed = await fetchSealedArtifact(runId, meta.id);
          const { filename, bytes } = openSealedArtifact(
            sealed,
            keyPair.publicKey,
            keyPair.privateKey
          );
          const kind = meta.kind ?? inferKind(announced, filename);
          // Copy into a fresh ArrayBuffer-backed Blob: libsodium returns a view
          // over its WASM heap (and TS 6's generic `Uint8Array<ArrayBufferLike>`
          // is not assignable to `BlobPart`), so a detached copy is both correct
          // and type-safe for an object URL that outlives the decrypt.
          const url = URL.createObjectURL(
            new Blob([toArrayBuffer(bytes)], { type: contentTypeFor(kind, filename) })
          );
          createdUrls.push(url);
          decrypted.push({ kind, filename, url });
        }
        if (active) setItems(decrypted);
        else for (const url of createdUrls) URL.revokeObjectURL(url);
      } catch {
        if (active) setError("Could not open your downloads. You can retry shortly.");
      }
    })();

    return () => {
      active = false;
      for (const url of createdUrls) URL.revokeObjectURL(url);
    };
  }, [runId, keyPair, announced]);

  if (error) {
    return <Banner tone="error">{error}</Banner>;
  }
  if (items === null) {
    return <LoadingState label="Preparing your documents…" />;
  }
  if (items.length === 0) {
    return <p className="result__no-docs">No documents were produced for this run.</p>;
  }
  return (
    <div className="downloads">
      <h3 className="downloads__title">Documents</h3>
      <ul className="downloads__list">
        {items.map((item) => (
          <li key={item.url} className="downloads__item">
            <span className="downloads__name">{artifactLabel(item.kind)}</span>
            <a className="btn btn--ghost" href={item.url} download={item.filename}>
              Download
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface DecryptedArtifact {
  kind: string;
  filename: string;
  url: string;
}

/**
 * Copies `bytes` into a fresh, standalone `ArrayBuffer`. libsodium returns
 * `Uint8Array` views over its WASM heap; copying detaches the data (safe for a
 * long-lived object URL) and yields a plain `ArrayBuffer` that satisfies the DOM
 * `BlobPart` type (TS 6's `Uint8Array<ArrayBufferLike>` does not).
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

/** Human label for an artifact kind. */
function artifactLabel(kind: string): string {
  switch (kind) {
    case "pdf":
      return "eVisa PDF";
    case "checker_html":
      return "Status check (web page)";
    case "checker_pdf":
      return "Status check (PDF)";
    default:
      return "Document";
  }
}

/** Best-effort content type from kind/filename for the download blob. */
function contentTypeFor(kind: string, filename: string): string {
  if (kind === "checker_html" || filename.endsWith(".html")) return "text/html";
  return "application/pdf";
}

/** Infers an artifact kind from the announced refs by filename when metadata is null. */
function inferKind(announced: SealedArtifactRef[], filename: string): string {
  const match = announced.find((a) => a.filename === filename);
  if (match) return match.kind;
  if (filename.endsWith(".html")) return "checker_html";
  return "pdf";
}

/** Terminal failure copy, with cause-specific phrasing. */
function FailureCard({
  failure,
}: {
  failure: { code: string; message: string; cause?: "cancelled" | "interrupted" };
}): ReactElement {
  const title =
    failure.cause === "cancelled"
      ? "Run cancelled"
      : failure.cause === "interrupted"
        ? "Run interrupted"
        : "Run failed";
  const help =
    failure.cause === "cancelled"
      ? "You cancelled this run. You can start a new one any time."
      : failure.cause === "interrupted"
        ? "The service restarted before this run finished. Please try again."
        : "Something went wrong during the run. You can try again.";
  return (
    <div className="card stack">
      <h2 className="card-title">{title}</h2>
      <Banner tone="error">{failure.message || help}</Banner>
      <p className="result__validity">{help}</p>
    </div>
  );
}

/** Cancel button for an in-flight run. */
function CancelButton({ runId }: { runId: string }): ReactElement {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  async function onCancel(): Promise<void> {
    setBusy(true);
    try {
      await cancelRun(runId);
      setDone(true);
    } catch {
      // A 409 (not cancellable) means it already finished; the stream will show it.
      setDone(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button variant="ghost" onClick={onCancel} loading={busy} disabled={done}>
      Cancel run
    </Button>
  );
}

/**
 * A ticking elapsed-seconds counter anchored to when the component mounted. To
 * reset it for a different run, give the consuming component a `key` so React
 * remounts it (see `ProgressCard` keyed by runId) — keeping this effect's deps
 * empty and honest.
 */
function useElapsed(): number {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(Date.now());
  useEffect(() => {
    const t = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, []);
  return elapsed;
}

/** Formats seconds as `m:ss`. */
function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Small page header used across run steps. */
function PageHead({ title }: { title: string }): ReactElement {
  return (
    <header className="page-head">
      <div>
        <p className="eyebrow">Share code</p>
        <h1 className="page-head__title">{title}</h1>
      </div>
    </header>
  );
}
