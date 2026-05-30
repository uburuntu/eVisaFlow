import { z } from "zod";
import { makeRequireUser } from "../../auth/session.js";
import type { Db } from "../../db/client.js";
import {
  addClientMember,
  countActiveFamilyMembers,
  type DbFamilyMember,
  deactivateFamilyMember,
  getActiveFamilyMembers,
  getFamilyMemberById,
} from "../../db/family-members.js";
import type { Logger } from "../../utils/logger.js";
import type { EntitlementService } from "../entitlements.js";
import type { WebFastifyInstance } from "../server.js";

/**
 * Member routes for the E2EE web app (client custody).
 *
 * SECURITY: client-custody members carry their applicant data ONLY as
 * `encryptedSecret` — an opaque blob sealed to the user's public key. The server
 * never sees or stores plaintext doc#/DOB/2fa. Every route is authenticated
 * (`requireUser`) and scoped to the caller (`request.user.id`); a user can never
 * read, create under, or delete another user's member. POST is additionally gated
 * by the {@link EntitlementService} max-members policy (a cloud seam; self-host
 * returns the schema cap of 6, which the DB trigger also enforces).
 *
 * Server-custody members (the trusted bot) are listed too, but their applicant
 * fields are never returned here — only the sealed `encryptedSecret` is exposed,
 * which is null for server rows.
 */

export interface MemberRoutesDeps {
  db: Db;
  entitlements: EntitlementService;
  log: Logger;
}

const createMemberBodySchema = z.object({
  displayName: z.string().trim().min(1).max(100),
  // v1 web app only creates client-custody members; server custody belongs to the
  // bot path. Pin the literal so the route can never be coaxed into a server row.
  custody: z.literal("client"),
  // Opaque sealed applicant blob (base64). Bound generously: the sealed JSON
  // applicant is well under a KiB, but allow headroom without inviting huge
  // bodies. The server never decodes the contents.
  encryptedSecret: z.string().min(1).max(8192),
});

/**
 * Public member shape. Intentionally exposes NO plaintext applicant fields: only
 * the identity, custody, and (for client custody) the sealed `encryptedSecret`
 * the client decrypts locally. `encryptedSecret` is null for server-custody rows.
 */
interface MemberResponse {
  id: string;
  displayName: string;
  custody: string;
  encryptedSecret: string | null;
}

function toMemberResponse(member: DbFamilyMember): MemberResponse {
  return {
    id: member.id,
    displayName: member.display_name,
    custody: member.custody,
    encryptedSecret: member.encrypted_secret
      ? member.encrypted_secret.toString("base64")
      : null,
  };
}

export function registerMemberRoutes(
  app: WebFastifyInstance,
  deps: MemberRoutesDeps
): void {
  const { db, entitlements } = deps;
  const requireUser = makeRequireUser(db);

  /**
   * List the caller's active members. Returns identity + custody + the sealed
   * `encryptedSecret` (base64) so the client can decrypt client-custody members
   * locally. Never returns plaintext applicant fields.
   */
  app.get("/api/members", { preHandler: requireUser }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthorized" });

    const members = await getActiveFamilyMembers(db, user.id);
    return reply.code(200).send({ members: members.map(toMemberResponse) });
  });

  /**
   * Create a client-custody member from a sealed `encryptedSecret`. Enforces the
   * entitlement max-members boundary against the caller's current active count
   * before insert; the DB trigger independently caps at 6. The sealed blob is
   * stored as-is (base64 → bytes); no plaintext is ever logged or persisted.
   */
  app.post("/api/members", { preHandler: requireUser }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthorized" });

    const parsed = createMemberBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_member" });
    }
    const { displayName, encryptedSecret } = parsed.data;

    // Entitlement gate (cloud seam; unlimited/self-host returns 6). Reject before
    // touching the DB when the caller is already at their cap.
    const [active, max] = await Promise.all([
      countActiveFamilyMembers(db, user.id),
      entitlements.maxMembers(user.id),
    ]);
    if (active >= max) {
      return reply.code(403).send({ error: "member_limit_reached" });
    }

    const member = await addClientMember(db, {
      user_id: user.id,
      display_name: displayName,
      encrypted_secret: Buffer.from(encryptedSecret, "base64"),
    });
    return reply.code(201).send(toMemberResponse(member));
  });

  /**
   * Soft-delete (deactivate) one of the caller's members. Ownership-scoped: a
   * member that does not exist OR belongs to another user returns 404 (no signal
   * about which). Idempotent — deactivating an already-inactive owned member is a
   * no-op but still resolved by the ownership lookup.
   */
  app.delete("/api/members/:id", { preHandler: requireUser }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "unauthorized" });

    const { id } = request.params as { id: string };
    // Ownership check: only the owner's member resolves; another user's (or a
    // missing) id is indistinguishable → 404.
    const member = await getFamilyMemberById(db, id, user.id);
    if (!member) {
      return reply.code(404).send({ error: "not_found" });
    }
    await deactivateFamilyMember(db, id, user.id);
    return reply.code(204).send();
  });
}
