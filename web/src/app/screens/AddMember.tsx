/**
 * Add-member wizard: collect a person's eVisa details, seal them to the user's
 * own public key IN THE BROWSER, and POST the opaque blob to `/api/members`.
 *
 * The server only ever receives `encryptedSecret` (a sealed blob) plus a display
 * name — never the plaintext document number, date of birth, 2FA choice, or
 * purpose. Inputs are validated client-side for a friendly experience (the run
 * route and core flow validate again server-side).
 */
import type * as React from "react";
import { type ReactElement, useState } from "react";
import { ApiError, createMember } from "../lib/api-client.js";
import {
  DOCUMENT_TYPE_LABELS,
  PURPOSE_LABELS,
  TWO_FACTOR_LABELS,
} from "../lib/labels.js";
import {
  type DocumentType,
  type MemberSecret,
  type Purpose,
  sealMemberSecret,
  type TwoFactorMethod,
} from "../lib/member-secret.js";
import { navigate } from "../runtime/router.js";
import { useVault } from "../runtime/vault-context.js";
import { Banner, Button, Field, Select, TextInput } from "../ui/primitives.js";

interface FormState {
  displayName: string;
  documentType: DocumentType;
  documentNumber: string;
  dob: string; // ISO yyyy-mm-dd from the date input
  twoFactorMethod: TwoFactorMethod;
  purpose: Purpose;
}

const INITIAL: FormState = {
  displayName: "",
  documentType: "passport",
  documentNumber: "",
  dob: "",
  twoFactorMethod: "sms",
  purpose: "right_to_work",
};

type Errors = Partial<Record<keyof FormState, string>>;

/** Parses an ISO `yyyy-mm-dd` to the `{day,month,year}` triple, or null if invalid. */
function parseDob(iso: string): { day: number; month: number; year: number } | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  // Reject impossible dates (e.g. 2023-02-31 rolls over) and the future.
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day ||
    d.getTime() > Date.now()
  ) {
    return null;
  }
  return { day, month, year };
}

function validate(form: FormState): Errors {
  const errors: Errors = {};
  if (form.displayName.trim().length === 0) {
    errors.displayName = "Enter a name so you can recognise this person.";
  } else if (form.displayName.trim().length > 100) {
    errors.displayName = "Use 100 characters or fewer.";
  }
  if (form.documentNumber.trim().length === 0) {
    errors.documentNumber = "Enter the document number.";
  } else if (form.documentNumber.trim().length > 100) {
    errors.documentNumber = "That document number looks too long.";
  }
  if (!parseDob(form.dob)) {
    errors.dob = "Enter a valid date of birth.";
  }
  return errors;
}

export function AddMember(): ReactElement {
  const { keyPair } = useVault();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [errors, setErrors] = useState<Errors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitError(null);
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    // The vault must be unlocked to seal — App only renders this when unlocked,
    // but guard anyway so we never attempt to seal without a key.
    if (!keyPair) {
      setSubmitError("Your vault is locked. Unlock it and try again.");
      return;
    }
    const dob = parseDob(form.dob);
    if (!dob) {
      setErrors((prev) => ({ ...prev, dob: "Enter a valid date of birth." }));
      return;
    }

    const secret: MemberSecret = {
      v: 1,
      documentType: form.documentType,
      documentNumber: form.documentNumber.trim(),
      dateOfBirth: dob,
      twoFactorMethod: form.twoFactorMethod,
      purpose: form.purpose,
    };

    setBusy(true);
    try {
      // Seal locally to our own public key; only the sealed blob is uploaded.
      const encryptedSecret = sealMemberSecret(secret, keyPair.publicKey);
      await createMember({
        displayName: form.displayName.trim(),
        custody: "client",
        encryptedSecret,
      });
      navigate({ name: "dashboard" });
    } catch (err) {
      if (err instanceof ApiError && err.code === "member_limit_reached") {
        setSubmitError("You've reached the maximum number of people.");
      } else {
        setSubmitError("Could not save this person. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-lg form-narrow">
      <header className="page-head">
        <div>
          <p className="eyebrow">New person</p>
          <h1 className="page-head__title">Add a person</h1>
        </div>
        <Button variant="ghost" onClick={() => navigate({ name: "dashboard" })}>
          Cancel
        </Button>
      </header>

      <p className="lead">
        These details are encrypted on this device before they're saved. We never see them
        in plain form.
      </p>

      <form className="card stack" onSubmit={onSubmit} noValidate>
        {submitError ? <Banner tone="error">{submitError}</Banner> : null}

        <Field label="Name (for your reference)" required error={errors.displayName}>
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              describedBy={describedBy}
              type="text"
              autoComplete="off"
              value={form.displayName}
              invalid={!!errors.displayName}
              onChange={(e) => update("displayName", e.target.value)}
              maxLength={100}
              required
            />
          )}
        </Field>

        <Field label="Document type" required>
          {({ id }) => (
            <Select
              id={id}
              value={form.documentType}
              onChange={(e) => update("documentType", e.target.value as DocumentType)}
            >
              {(Object.keys(DOCUMENT_TYPE_LABELS) as DocumentType[]).map((t) => (
                <option key={t} value={t}>
                  {DOCUMENT_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Document number" required error={errors.documentNumber}>
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              describedBy={describedBy}
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={form.documentNumber}
              invalid={!!errors.documentNumber}
              onChange={(e) => update("documentNumber", e.target.value)}
              maxLength={100}
              required
            />
          )}
        </Field>

        <Field label="Date of birth" required error={errors.dob}>
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              describedBy={describedBy}
              type="date"
              value={form.dob}
              invalid={!!errors.dob}
              onChange={(e) => update("dob", e.target.value)}
              max={new Date().toISOString().slice(0, 10)}
              required
            />
          )}
        </Field>

        <Field
          label="How they receive their security code"
          hint="The eVisa service sends a one-time code during each check."
        >
          {({ id, describedBy }) => (
            <Select
              id={id}
              describedBy={describedBy}
              value={form.twoFactorMethod}
              onChange={(e) =>
                update("twoFactorMethod", e.target.value as TwoFactorMethod)
              }
            >
              {(Object.keys(TWO_FACTOR_LABELS) as TwoFactorMethod[]).map((m) => (
                <option key={m} value={m}>
                  {TWO_FACTOR_LABELS[m]}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Default purpose" hint="You can change this for each share code.">
          {({ id, describedBy }) => (
            <Select
              id={id}
              describedBy={describedBy}
              value={form.purpose}
              onChange={(e) => update("purpose", e.target.value as Purpose)}
            >
              {(Object.keys(PURPOSE_LABELS) as Purpose[]).map((p) => (
                <option key={p} value={p}>
                  {PURPOSE_LABELS[p]}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Button type="submit" loading={busy} block>
          Save person
        </Button>
      </form>
    </div>
  );
}
