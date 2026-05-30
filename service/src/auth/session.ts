import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/client.js";
import {
  createSession,
  deleteSession,
  findValidSessionByTokenHash,
} from "../db/sessions.js";
import { type DbUser, getUserById } from "../db/users.js";

/**
 * Hashed-session authentication for the web app.
 *
 * SECURITY model (non-negotiable):
 * - The session token is high-entropy random bytes generated server-side.
 * - ONLY its SHA-256 hash is ever persisted (`sessions.token_hash`); the raw
 *   token lives solely in an HttpOnly cookie, so a database compromise yields no
 *   usable tokens and JS in the browser cannot read it.
 * - The cookie is `HttpOnly; Secure; SameSite=Lax; Path=/` with `Max-Age` derived
 *   from the session expiry, mitigating XSS theft, CSRF (Lax), and plaintext
 *   transport (Secure).
 * - Lookups hash the presented token and compare against stored hashes; an
 *   expired or unknown token is indistinguishable (both → unauthenticated).
 */

/** Cookie name carrying the raw session token. */
export const SESSION_COOKIE = "evisa_session";

/** 32 random bytes → 43-char base64url token (~256 bits of entropy). */
const SESSION_TOKEN_BYTES = 32;

/** Default session lifetime: 30 days. */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Generates a fresh, high-entropy session token (URL-safe, no padding). */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

/** SHA-256 hash (hex) of a token — the only form ever stored or queried. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Constant-time comparison of two same-length hex hashes. Used where a token is
 * matched against a known value in-process; DB lookups already match by the
 * indexed hash. Returns false for differing lengths (never throws).
 */
export function safeHashEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Shared cookie attributes enforcing the security posture above. */
function sessionCookieOptions(maxAgeSeconds: number): {
  httpOnly: true;
  secure: true;
  sameSite: "lax";
  path: "/";
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/**
 * Creates a new session for `userId`: generates a token, persists ONLY its hash
 * with an `expires_at`, and sets the HttpOnly session cookie on `reply`. Returns
 * the raw token (for callers that need it, e.g. tests); the caller never persists
 * it. `ttlMs` defaults to {@link DEFAULT_SESSION_TTL_MS}.
 */
export async function startSession(
  db: Db,
  reply: FastifyReply,
  userId: string,
  ttlMs: number = DEFAULT_SESSION_TTL_MS
): Promise<string> {
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await createSession(db, {
    user_id: userId,
    token_hash: tokenHash,
    expires_at: expiresAt,
  });
  reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(Math.floor(ttlMs / 1000)));
  return token;
}

/**
 * Reads the session cookie from `request`, validates it (hash → unexpired DB
 * lookup), and resolves the owning user. Returns null when there is no cookie,
 * the session is unknown/expired, or the user no longer exists. NEVER reveals
 * which of those it was.
 */
export async function readSessionUser(
  db: Db,
  request: FastifyRequest
): Promise<DbUser | null> {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const session = await findValidSessionByTokenHash(db, hashSessionToken(token));
  if (!session) return null;
  return getUserById(db, session.user_id);
}

/**
 * Destroys the current session (logout): deletes the session row for the cookie's
 * token hash (if present) and clears the cookie on `reply`. Idempotent — safe to
 * call without an active session.
 */
export async function destroySession(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const token = request.cookies?.[SESSION_COOKIE];
  if (token) {
    await deleteSession(db, hashSessionToken(token)).catch(() => {});
  }
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/**
 * The authenticated user attached to a request by {@link requireUser} /
 * {@link optionalUser}. Declared on Fastify's request via module augmentation so
 * route handlers can read `request.user` with full typing.
 */
declare module "fastify" {
  interface FastifyRequest {
    user?: DbUser;
  }
}

/**
 * Builds a Fastify `preHandler` that loads the session user onto `request.user`
 * and replies 401 (without leaking detail) when there is no valid session. Bound
 * to `db` so routes can register it directly. Apply to every route that needs an
 * authenticated user; ownership checks on the resolved `request.user.id` happen
 * in the individual handlers.
 */
export function makeRequireUser(db: Db) {
  return async function requireUser(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const user = await readSessionUser(db, request);
    if (!user) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    request.user = user;
  };
}

/**
 * Like {@link makeRequireUser} but never rejects: it attaches `request.user` when
 * a valid session exists and otherwise leaves it undefined, letting the handler
 * branch on authentication (e.g. public pages that personalize when signed in).
 */
export function makeOptionalUser(db: Db) {
  return async function optionalUser(request: FastifyRequest): Promise<void> {
    const user = await readSessionUser(db, request);
    if (user) {
      request.user = user;
    }
  };
}
