/**
 * Login page behaviour: the email magic-link form and the Telegram Login Widget
 * callback. Kept out of the `.astro` file so it's plain, typed TypeScript.
 *
 * Magic link: POST the email to `/api/auth/magic-link`. The endpoint ALWAYS
 * replies 204 (it never reveals whether an address has an account — no
 * enumeration), so the UI shows the same "check your email" confirmation on any
 * non-error outcome. We never echo the email back into a URL or log it.
 *
 * Telegram: the widget script (loaded by the page when a bot username is
 * configured) calls `window.onTelegramAuth(user)` with the signed payload. We
 * forward it verbatim to `POST /api/auth/telegram`, which verifies the HMAC and
 * `auth_date` server-side, then redirect into the app on success.
 */
import { ApiError, apiFetch } from "../lib/api.js";

/** Where to land after a successful sign-in. The app island lives here. */
const APP_PATH = "/app";

/** The Telegram widget payload (a flat signed object). Forwarded as-is. */
interface TelegramAuthPayload {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

declare global {
  interface Window {
    onTelegramAuth?: (user: TelegramAuthPayload) => void;
  }
}

/** Sets a status region's message and tone, keeping it announced to AT. */
function setStatus(
  el: HTMLElement | null,
  message: string,
  tone: "info" | "success" | "error"
): void {
  if (!el) return;
  el.textContent = message;
  el.dataset.tone = tone;
  el.hidden = false;
}

/** Wires the email magic-link form: validate lightly, POST, confirm. */
function initMagicLinkForm(): void {
  const form = document.querySelector<HTMLFormElement>("[data-magic-form]");
  if (!form) return;

  const input = form.querySelector<HTMLInputElement>('input[type="email"]');
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const status = document.querySelector<HTMLElement>("[data-magic-status]");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = input?.value.trim() ?? "";
    // The server validates and bounds the address; this is only a friendly
    // pre-check so an empty submit doesn't fire a pointless request.
    if (email.length < 3 || !email.includes("@")) {
      setStatus(status, "Please enter a valid email address.", "error");
      input?.focus();
      return;
    }

    if (button) button.disabled = true;
    setStatus(status, "Sending your sign-in link…", "info");

    try {
      await apiFetch("/auth/magic-link", { method: "POST", json: { email } });
      // 204 regardless of whether the account exists — show the same message so
      // the page is not an account-enumeration oracle.
      setStatus(
        status,
        "If that address can sign in, a magic link is on its way. Check your inbox (and spam).",
        "success"
      );
      form.reset();
    } catch (error) {
      // Network/5xx only — a 2xx (including 204) never throws here.
      const message =
        error instanceof ApiError && error.status === 429
          ? "Too many requests just now. Please wait a moment and try again."
          : "Something went wrong sending the link. Please try again.";
      setStatus(status, message, "error");
    } finally {
      if (button) button.disabled = false;
    }
  });
}

/** Installs the global Telegram widget callback. */
function initTelegramAuth(): void {
  const status = document.querySelector<HTMLElement>("[data-telegram-status]");

  window.onTelegramAuth = async (user: TelegramAuthPayload) => {
    setStatus(status, "Verifying your Telegram sign-in…", "info");
    try {
      await apiFetch("/auth/telegram", { method: "POST", json: user });
      setStatus(status, "Signed in. Taking you to your dashboard…", "success");
      window.location.assign(APP_PATH);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : undefined;
      const message =
        code === "telegram_already_linked"
          ? "That Telegram account is already linked to a different eVisaFlow account."
          : "Telegram sign-in could not be verified. Please try again.";
      setStatus(status, message, "error");
    }
  };
}

initMagicLinkForm();
initTelegramAuth();
