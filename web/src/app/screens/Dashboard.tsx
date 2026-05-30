/**
 * Dashboard: the home screen once the vault is unlocked. Lists the user's people
 * (members) with a friendly, locally-decrypted summary and a "Get share code"
 * action per person, plus add-member and history entry points.
 *
 * For each client-custody member we open the sealed `encryptedSecret` IN THE
 * BROWSER (with the unlocked key pair) to show the document type and a masked
 * number — never uploading anything. The server-provided `displayName` is shown
 * without needing to decrypt. If a secret fails to open (e.g. it was sealed to a
 * different key), we degrade to just the name plus a clear note.
 */
import { type ReactElement, useEffect, useMemo, useState } from "react";
import { deleteMember, listMembers, type Member } from "../lib/api-client.js";
import {
  DOCUMENT_TYPE_LABELS,
  maskDocumentNumber,
  PURPOSE_LABELS,
} from "../lib/labels.js";
import { type MemberSecret, openMemberSecret } from "../lib/member-secret.js";
import { navigate } from "../runtime/router.js";
import { useVault } from "../runtime/vault-context.js";
import { Banner, Button, EmptyState, LoadingState, Modal } from "../ui/primitives.js";

/** A member plus the result of trying to open its sealed secret locally. */
interface DecoratedMember {
  member: Member;
  secret: MemberSecret | null;
  /** True when the member had a secret we could not open. */
  undecryptable: boolean;
}

export function Dashboard(): ReactElement {
  const { keyPair } = useVault();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Member | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let active = true;
    setError(null);
    listMembers()
      .then((rows) => {
        if (active) setMembers(rows);
      })
      .catch(() => {
        if (active) setError("Could not load your people. Please refresh and try again.");
      });
    return () => {
      active = false;
    };
  }, []);

  // Decrypt each member's secret locally for display. Recomputed if the member
  // list or the unlocked key changes. Pure/in-memory — no network, no upload.
  const decorated = useMemo<DecoratedMember[]>(() => {
    if (!members) return [];
    return members.map((member) => {
      if (!member.encryptedSecret || !keyPair) {
        return { member, secret: null, undecryptable: false };
      }
      try {
        return {
          member,
          secret: openMemberSecret(member.encryptedSecret, keyPair),
          undecryptable: false,
        };
      } catch {
        return { member, secret: null, undecryptable: true };
      }
    });
  }, [members, keyPair]);

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteMember(pendingDelete.id);
      setMembers((prev) => prev?.filter((m) => m.id !== pendingDelete.id) ?? prev);
      setPendingDelete(null);
    } catch {
      setError("Could not remove that person. Please try again.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="stack-lg">
      <header className="page-head">
        <div>
          <p className="eyebrow">Your people</p>
          <h1 className="page-head__title">Dashboard</h1>
        </div>
        <Button onClick={() => navigate({ name: "add-member" })}>Add a person</Button>
      </header>

      {error ? <Banner tone="error">{error}</Banner> : null}

      {members === null ? (
        <LoadingState label="Loading your people…" />
      ) : decorated.length === 0 ? (
        <EmptyState
          title="No people added yet"
          description="Add a person to securely store their details and generate eVisa share codes on demand."
          action={
            <Button onClick={() => navigate({ name: "add-member" })}>
              Add your first person
            </Button>
          }
        />
      ) : (
        <ul className="member-grid" aria-label="People">
          {decorated.map((row) => (
            <li key={row.member.id}>
              <MemberCard
                row={row}
                onRun={() => navigate({ name: "run", memberId: row.member.id })}
                onDelete={() => setPendingDelete(row.member)}
              />
            </li>
          ))}
        </ul>
      )}

      {pendingDelete ? (
        <Modal title="Remove this person?" onClose={() => setPendingDelete(null)}>
          <p className="lead">
            Remove <strong>{pendingDelete.displayName}</strong>? Their stored, encrypted
            details will be deleted. You can add them again later.
          </p>
          <div className="modal__actions">
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button variant="accent" loading={deleting} onClick={confirmDelete}>
              Remove
            </Button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/** One person card: name, locally-decrypted summary, and actions. */
function MemberCard({
  row,
  onRun,
  onDelete,
}: {
  row: DecoratedMember;
  onRun: () => void;
  onDelete: () => void;
}): ReactElement {
  const { member, secret, undecryptable } = row;
  return (
    <div className="card member-card stack">
      <div className="member-card__head">
        <h2 className="member-card__name">{member.displayName}</h2>
        <button
          type="button"
          className="icon-btn"
          onClick={onDelete}
          aria-label={`Remove ${member.displayName}`}
        >
          Remove
        </button>
      </div>

      {secret ? (
        <dl className="member-card__meta">
          <div>
            <dt>Document</dt>
            <dd>{DOCUMENT_TYPE_LABELS[secret.documentType]}</dd>
          </div>
          <div>
            <dt>Number</dt>
            <dd>
              <code>{maskDocumentNumber(secret.documentNumber)}</code>
            </dd>
          </div>
          <div>
            <dt>Default purpose</dt>
            <dd>{PURPOSE_LABELS[secret.purpose]}</dd>
          </div>
        </dl>
      ) : undecryptable ? (
        <Banner tone="error">
          This person's details could not be unlocked with your current key.
        </Banner>
      ) : (
        <p className="member-card__meta-empty">Unlock your vault to see details.</p>
      )}

      <div className="member-card__actions">
        <Button block onClick={onRun} disabled={!secret}>
          Get share code
        </Button>
      </div>
    </div>
  );
}
