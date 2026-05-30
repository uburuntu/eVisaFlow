import { z } from "zod";
import { consumeMagicLink, issueMagicLink } from "../../auth/magic-link.js";
import { destroySession, readSessionUser, startSession } from "../../auth/session.js";
import { verifyTelegramLogin } from "../../auth/telegram-verify.js";
import type { Db } from "../../db/client.js";
import { getVault } from "../../db/user-vault.js";
import {
  type DbUser,
  findOrCreateUserByEmail,
  findOrCreateUserByTelegram,
  linkTelegramId,
} from "../../db/users.js";
import type { Env } from "../../env.js";
import type { Logger } from "../../utils/logger.js";
import type { Mailer } from "../mailer.js";
import type { WebFastifyInstance } from "../server.js";

/**
 * Authentication routes: email magic-link + Telegram Login, plus session
 * lifecycle (`logout`, `me`).
 *
 * SECURITY posture enforced here (non-negotiable):
 * - Sessions are random tokens stored ONLY as a hash, in an HttpOnly; Secure;
 *   SameSite=Lax cookie (see `auth/session.ts`).
 * - Magic-link endpoints NEVER reveal whether an email exists: the request
 *   endpoint always returns 204, and the verify endpoint reveals nothing about a
 *   token beyond "valid" vs "not".
 * - Telegram Login is verified by HMAC-SHA256 over the data-check-string keyed by
 *   SHA256(bot token), with a constant-time compare and an `auth_date` freshness
 *   check (see `auth/telegram-verify.ts`).
 */

export interface AuthRoutesDeps {
  db: Db;
  env: Env;
  mailer: Mailer;
  log: Logger;
}

/** Public shape of the authenticated user returned by `me` / `telegram`. */
interface MeResponse {
  id: string;
  email: string | null;
  telegramLinked: boolean;
  hasVault: boolean;
}

async function toMeResponse(db: Db, user: DbUser): Promise<MeResponse> {
  const vault = await getVault(db, user.id);
  return {
    id: user.id,
    email: user.email,
    telegramLinked: user.telegram_id !== null,
    hasVault: vault !== null,
  };
}

const magicLinkBodySchema = z.object({
  // Loose email validation: the goal is to avoid obviously-bad input, not to be
  // an oracle. Invalid bodies still return 204 (no enumeration / no signal).
  email: z.string().trim().min(3).max(320).email(),
});

// Telegram Login payload: a flat object of string/number fields plus `hash`. We
// accept any extra fields (Telegram may add some) and fold them into the
// signature check. `hash` is required for a verification to be possible at all.
const telegramBodySchema = z
  .object({ hash: z.string().min(1) })
  .catchall(z.union([z.string(), z.number()]));

export function registerAuthRoutes(app: WebFastifyInstance, deps: AuthRoutesDeps): void {
  const { db, env, mailer, log } = deps;
  const sessionTtlMs = env.SESSION_TTL_MINUTES * 60_000;
  const magicLinkTtlMs = env.MAGIC_LINK_TTL_MINUTES * 60_000;

  /**
   * Request a magic link. ALWAYS responds 204 — whether the email is well-formed,
   * already has an account, or has never been seen — so the endpoint can never be
   * used to enumerate which addresses are registered. A token is issued and the
   * email dispatched best-effort; delivery failures are logged WITHOUT the link
   * and do not change the response.
   */
  app.post("/api/auth/magic-link", async (request, reply) => {
    const parsed = magicLinkBodySchema.safeParse(request.body);
    // Malformed input is indistinguishable from success to the caller (204), but
    // we skip issuing a token for it. NOTE: never log request.body — it carries
    // the email (PII) and, on other routes, plaintext applicant data.
    if (parsed.success) {
      const { email } = parsed.data;
      try {
        const token = await issueMagicLink(db, email, magicLinkTtlMs);
        const verifyUrl = `${env.PUBLIC_BASE_URL}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`;
        await mailer.sendMagicLink(email, verifyUrl);
      } catch (err) {
        // Do not leak the link or whether the address exists; just record that
        // dispatch failed so operators can diagnose transport issues.
        log.error({ err }, "Failed to issue/send magic link");
      }
    }
    return reply.code(204).send();
  });

  /**
   * Verify a magic link. Consumes the (single-use, unexpired) token, upserts the
   * user by email (creating one on first sign-in), starts a session, and redirects
   * to the app. An unknown/consumed/expired token redirects to the login page with
   * a generic error — revealing nothing about the token's prior state.
   */
  app.get("/api/auth/magic-link/verify", async (request, reply) => {
    const token = (request.query as { token?: string } | undefined)?.token;
    const email = token ? await consumeMagicLink(db, token) : null;
    if (!email) {
      return reply.redirect(`${env.PUBLIC_BASE_URL}/login?error=invalid_link`);
    }
    const user = await findOrCreateUserByEmail(db, email);
    await startSession(db, reply, user.id, sessionTtlMs);
    return reply.redirect(`${env.PUBLIC_BASE_URL}/app`);
  });

  /**
   * Telegram Login. Verifies the widget payload's HMAC and `auth_date` freshness.
   * If a valid session is already present, LINKS the Telegram id to that user
   * (returning 409 when the id is already bound to someone else); otherwise it
   * finds-or-creates the user for that Telegram id. Either way a session is
   * started and the current user is returned.
   */
  app.post("/api/auth/telegram", async (request, reply) => {
    const parsed = telegramBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload" });
    }
    const result = verifyTelegramLogin(parsed.data, env.TELEGRAM_BOT_TOKEN);
    if (!result.ok) {
      // Collapse every failure (bad signature, stale, missing fields) into one
      // 401 so the response never hints at which check failed.
      return reply.code(401).send({ error: "telegram_auth_failed" });
    }
    const { id, first_name, username } = result.user;

    const existing = await readSessionUser(db, request);
    let user: DbUser;
    if (existing) {
      const linked = await linkTelegramId(db, existing.id, id);
      if (!linked) {
        return reply.code(409).send({ error: "telegram_already_linked" });
      }
      user = linked;
    } else {
      user = await findOrCreateUserByTelegram(
        db,
        id,
        first_name ?? null,
        username ?? null
      );
    }

    await startSession(db, reply, user.id, sessionTtlMs);
    return reply.code(200).send(await toMeResponse(db, user));
  });

  /**
   * Log out. Destroys the current session (deletes the row for the cookie's token
   * hash) and clears the cookie. Idempotent — 204 even without an active session.
   */
  app.post("/api/auth/logout", async (request, reply) => {
    await destroySession(db, request, reply);
    return reply.code(204).send();
  });

  /**
   * Current user. Returns the authenticated user's public profile (id, email,
   * whether Telegram is linked, whether a vault exists) or 401 when not signed in.
   */
  app.get("/api/auth/me", async (request, reply) => {
    const user = await readSessionUser(db, request);
    if (!user) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return reply.code(200).send(await toMeResponse(db, user));
  });
}
