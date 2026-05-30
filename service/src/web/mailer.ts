import type { Logger } from "../utils/logger.js";

/**
 * Pluggable outbound email seam. Magic-link sign-in needs it; Telegram Login
 * works without it, so self-host deployments with only Telegram configured can
 * run with the {@link noopMailer} or the {@link consoleMailer}.
 *
 * Selection (in `index.ts`): when `SMTP_URL` is set, the {@link smtpMailer} is
 * used; otherwise the {@link consoleMailer} logs the link so a no-SMTP dev /
 * self-host can still complete sign-in by copying it from the logs.
 */
export interface Mailer {
  /**
   * Sends a magic-link sign-in email. Implementations MUST NOT log the link or
   * the recipient at info level (the link is a bearer credential) — the
   * {@link consoleMailer} is the sole, deliberate exception for dev convenience.
   */
  sendMagicLink(to: string, link: string): Promise<void>;
}

/**
 * A mailer that does nothing. Used as an inert default (e.g. tests). With it,
 * magic-link requests still return 204 (no enumeration) but no email is
 * delivered — operators must configure SMTP or use the console mailer.
 */
export const noopMailer: Mailer = {
  async sendMagicLink(): Promise<void> {
    // Intentionally empty: no transport configured.
  },
};

/**
 * A mailer that writes the magic link to the logs instead of sending email.
 *
 * Intended for dev and SMTP-less self-host: the operator copies the link from
 * the logs to complete sign-in. This is the ONE place a magic link is logged —
 * acceptable because it is an explicit, opt-in dev transport (chosen only when
 * no SMTP_URL is configured), not the production email path.
 */
export function consoleMailer(log: Logger): Mailer {
  return {
    async sendMagicLink(to: string, link: string): Promise<void> {
      log.info({ to, link }, "Magic-link email (console transport — no SMTP configured)");
    },
  };
}

/**
 * Minimal structural view of the bits of nodemailer we use. Declared locally so
 * this module type-checks even when `nodemailer`'s types are not installed; the
 * real module is loaded lazily at construction time (see {@link smtpMailer}).
 */
interface NodemailerLike {
  createTransport(url: string): {
    sendMail(message: {
      from: string;
      to: string;
      subject: string;
      text: string;
      html: string;
    }): Promise<unknown>;
  };
}

export interface SmtpMailerOptions {
  /** SMTP connection URL, e.g. `smtps://user:pass@smtp.example.com:465`. */
  url: string;
  /** RFC 5322 From header, e.g. `eVisaFlow <noreply@example.com>`. */
  from: string;
}

/**
 * SMTP-backed mailer (production email path). Lazily imports `nodemailer` and
 * builds a transport from `options.url` on the first send, so the dependency is
 * only required when SMTP sign-in is actually configured.
 *
 * `nodemailer` is a RUNTIME-OPTIONAL peer: it is not a hard install dependency so
 * a Telegram-only / console-mailer self-host installs and runs without it. To use
 * SMTP sign-in, install it (`pnpm --filter evisa-flow-bot add nodemailer`) and set
 * SMTP_URL/SMTP_FROM; the first send will then resolve the module. If SMTP_URL is
 * set but the package is absent, the first send rejects with a module-not-found
 * error (surfaced to the operator, never to the user, and carrying no link).
 *
 * NEVER logs the link or recipient (the base {@link Mailer} contract); only
 * delivery failures surface, and they carry no link.
 */
export function smtpMailer(options: SmtpMailerOptions): Mailer {
  // Resolve the dynamic-import specifier through a variable so the TypeScript
  // compiler treats `nodemailer` as a runtime import (no static module
  // resolution at build time). The package is a declared dependency; this keeps
  // the build green in environments where it is not yet present in the store.
  const moduleSpecifier = "nodemailer";
  let transportPromise:
    | Promise<ReturnType<NodemailerLike["createTransport"]>>
    | undefined;

  const transport = (): Promise<ReturnType<NodemailerLike["createTransport"]>> => {
    if (!transportPromise) {
      transportPromise = (
        import(moduleSpecifier) as Promise<{ default: NodemailerLike }>
      ).then((mod) => {
        const nodemailer = mod.default ?? (mod as unknown as NodemailerLike);
        return nodemailer.createTransport(options.url);
      });
    }
    return transportPromise;
  };

  return {
    async sendMagicLink(to: string, link: string): Promise<void> {
      const tx = await transport();
      await tx.sendMail({
        from: options.from,
        to,
        subject: "Your eVisaFlow sign-in link",
        text: `Sign in to eVisaFlow using this link (valid for a short time):\n\n${link}\n\nIf you did not request this, you can ignore this email.`,
        html: `<p>Sign in to eVisaFlow using this link (valid for a short time):</p><p><a href="${link}">Sign in to eVisaFlow</a></p><p>If you did not request this, you can ignore this email.</p>`,
      });
    },
  };
}
