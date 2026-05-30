/**
 * Cloud seam (not exercised in v1 self-host). Lets a later paid-tier build gate
 * run creation and member counts per plan WITHOUT changing any route signature.
 * v1 binds {@link unlimitedEntitlements}, which allows everything.
 */
export interface EntitlementService {
  /** Whether `userId` may start another run right now. */
  canCreateRun(userId: string): Promise<boolean>;
  /** Maximum active members allowed for `userId` (the schema trigger still caps at 6). */
  maxMembers(userId: string): Promise<number>;
}

/**
 * The v1 / self-host entitlement policy: unlimited. `canCreateRun` is always
 * true and `maxMembers` returns the schema's hard cap of 6 active members per
 * user (enforced independently by the `trg_max_family_members` trigger).
 */
export const unlimitedEntitlements: EntitlementService = {
  async canCreateRun(): Promise<boolean> {
    return true;
  },
  async maxMembers(): Promise<number> {
    return 6;
  },
};
