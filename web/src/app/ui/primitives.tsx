/**
 * Small, accessible UI primitives shared across the app island.
 *
 * These deliberately reuse the marketing design system's classes (`.btn`,
 * `.card`, `.badge`, `.eyebrow`, …) from `src/styles/global.css` so the app feels
 * like one product with the static shell. Island-specific structure (form fields
 * with labels + error wiring, status banners, a spinner, a focus-trapping modal)
 * is added here and styled in `app/app.css`. Everything keeps WCAG basics:
 * labelled controls, `aria-invalid`/`aria-describedby` on errored fields,
 * `role="status"`/`role="alert"` live regions, and visible focus.
 */
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  useEffect,
  useId,
  useRef,
} from "react";

type ButtonVariant = "primary" | "accent" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  block?: boolean;
  /** Renders a spinner and disables the button while a request is in flight. */
  loading?: boolean;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "",
  accent: "btn--accent",
  ghost: "btn--ghost",
};

/** A button styled with the shared `.btn` system; optional inline loading state. */
export function Button({
  variant = "primary",
  block = false,
  loading = false,
  disabled,
  children,
  className,
  type = "button",
  ...rest
}: ButtonProps): ReactElement {
  const classes = ["btn", VARIANT_CLASS[variant], block ? "btn--block" : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner inline /> : null}
      {children}
    </button>
  );
}

/** An accessible spinner. `inline` keeps it on the text baseline inside buttons. */
export function Spinner({
  inline = false,
  label = "Loading",
}: {
  inline?: boolean;
  label?: string;
}): ReactElement {
  return (
    <span
      className={inline ? "spinner spinner--inline" : "spinner"}
      role="status"
      aria-label={label}
    />
  );
}

type FieldChild = (props: { id: string; describedBy?: string }) => ReactNode;

interface FieldProps {
  label: string;
  /** Validation/help text rendered below; tone="error" wires aria-invalid. */
  hint?: string;
  error?: string;
  required?: boolean;
  /** Render-prop so the control gets the generated id + describedBy. */
  children: FieldChild;
}

/**
 * A labelled form field. Generates a stable id, links the label, and wires any
 * hint/error to the control via `aria-describedby`. Pass the control through the
 * render prop so the id/describedBy land on the actual input/select.
 */
export function Field({
  label,
  hint,
  error,
  required,
  children,
}: FieldProps): ReactElement {
  const id = useId();
  const msgId = `${id}-msg`;
  const message = error ?? hint;
  const describedBy = message ? msgId : undefined;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {children({ id, describedBy })}
      {message ? (
        <p
          id={msgId}
          className={`field__msg${error ? " field__msg--error" : ""}`}
          role={error ? "alert" : undefined}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}

type TextInputProps = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
  describedBy?: string;
};

/** A text input styled to the field system; pass `invalid` to flag errors. */
export function TextInput({
  invalid,
  describedBy,
  className,
  ...rest
}: TextInputProps): ReactElement {
  return (
    <input
      className={["control", className].filter(Boolean).join(" ")}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      {...rest}
    />
  );
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
  describedBy?: string;
};

/** A native select styled to match the text inputs. */
export function Select({
  invalid,
  describedBy,
  className,
  children,
  ...rest
}: SelectProps): ReactElement {
  return (
    <select
      className={["control", "control--select", className].filter(Boolean).join(" ")}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      {...rest}
    >
      {children}
    </select>
  );
}

type BannerTone = "info" | "success" | "error";

/**
 * A status/alert banner. Errors use `role="alert"` (assertive) so screen readers
 * announce failures immediately; info/success use `role="status"` (polite).
 */
export function Banner({
  tone,
  children,
}: {
  tone: BannerTone;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      className={`banner banner--${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

/** A centered loading state for whole-screen async work. */
export function LoadingState({ label = "Loading…" }: { label?: string }): ReactElement {
  return (
    <div className="state state--loading">
      <Spinner label={label} />
      <p className="state__text">{label}</p>
    </div>
  );
}

/** A friendly empty state with an optional call to action. */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}): ReactElement {
  return (
    <div className="state state--empty card">
      <h3 className="state__title">{title}</h3>
      {description ? <p className="state__text">{description}</p> : null}
      {action ? <div className="state__action">{action}</div> : null}
    </div>
  );
}

/**
 * A modal dialog with a focus trap and Escape-to-close. Used for the one-time
 * recovery kit (where dismissal must be a deliberate acknowledgement) and
 * confirmations. Renders a backdrop; the panel is `role="dialog"` + `aria-modal`.
 * `dismissable={false}` removes the Escape/backdrop close so the user must use an
 * explicit button (the recovery kit relies on this).
 */
export function Modal({
  title,
  onClose,
  dismissable = true,
  children,
}: {
  title: string;
  onClose: () => void;
  dismissable?: boolean;
  children: ReactNode;
}): ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Move focus into the dialog on open.
    panelRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && dismissable) {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      // Trap focus within the panel.
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [onClose, dismissable]);

  return (
    <div className="modal-backdrop">
      {/*
       * A real <button> backdrop gives click-to-close accessible semantics
       * (focusable, keyboard-activatable) without static-element-interaction
       * lint warnings. It sits behind the panel; Escape is handled above too.
       * Hidden from AT (the dialog already traps focus and labels itself).
       */}
      {dismissable ? (
        <button
          type="button"
          className="modal-backdrop__close"
          aria-label="Close dialog"
          tabIndex={-1}
          onClick={onClose}
        />
      ) : null}
      <div
        ref={panelRef}
        className="modal card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId} className="modal__title">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
