/**
 * Cross-creator access.
 *
 * Orthogonal to workspace membership. A platform admin is deliberately not a
 * member of every workspace, because membership is what a creator sees in their
 * own member list, and an operator appearing there would be alarming and wrong.
 *
 * Resolved from PlatformGrant rows rather than a column on User, so the standing
 * permission and each use of it are both recorded. A column can only answer
 * whether someone is an admin today.
 */

import { prisma } from "@/lib/db/client";
import { getCurrentUserId } from "@/lib/auth";
import type { PlatformGrantTier } from "@/app/generated/prisma/client";

export type { PlatformGrantTier };

const RANK = {
  SUPPORT_READ: 1,
  SUPPORT_FULL: 2,
  ADMIN: 3,
} satisfies Record<PlatformGrantTier, number>;

export interface PlatformScope {
  userId: string;
  tier: PlatformGrantTier;
  grantId: string;
  /** SUPPORT_READ cannot see message or comment bodies. */
  canReadContent: boolean;
}

/**
 * The highest currently-active grant, or null. An expired grant is
 * indistinguishable from never having had one, which is the point of setting an
 * expiry on support access.
 */
export async function getPlatformScope(): Promise<PlatformScope | null> {
  const userId = await getCurrentUserId();
  if (!userId) return null;

  const now = new Date();
  const grants = await prisma.platformGrant.findMany({
    where: {
      userId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { id: true, tier: true },
  });
  if (grants.length === 0) return null;

  const best = grants.reduce((a, b) => (RANK[b.tier] > RANK[a.tier] ? b : a));
  return {
    userId,
    tier: best.tier,
    grantId: best.id,
    canReadContent: RANK[best.tier] >= RANK.SUPPORT_FULL,
  };
}

export async function requirePlatformScope(
  minimum: PlatformGrantTier = "SUPPORT_READ"
): Promise<PlatformScope> {
  const scope = await getPlatformScope();
  if (!scope || RANK[scope.tier] < RANK[minimum]) {
    throw new PlatformAccessError();
  }
  return scope;
}

export class PlatformAccessError extends Error {
  constructor() {
    super("Cross-creator access requires an active platform grant");
    this.name = "PlatformAccessError";
  }
}

/**
 * Act inside one creator's workspace, as a platform admin.
 *
 * Editing a creator's campaign is a deliberate product decision, not an
 * accident of scope. What makes it safe is that the authority and the use of it
 * are separate records: the grant says who may, and one row per action says who
 * did. Reading is enough for SUPPORT_FULL; changing a creator's data is not.
 *
 * Throws rather than returning null, so a caller cannot reach a creator's
 * workspace by ignoring a return value.
 */
export async function assumeWorkspace(
  workspaceId: string,
  action: string
): Promise<PlatformScope> {
  const scope = await requirePlatformScope("ADMIN");
  await recordAdminAccess({ scope, action, workspaceId });
  return scope;
}

export async function recordAdminAccess(params: {
  scope: PlatformScope;
  action: string;
  workspaceId?: string | null;
}): Promise<void> {
  // A row rather than a JSON payload on OperationalEvent, because "who read this
  // creator's data" has to be answerable by query. A null workspaceId means the
  // read genuinely spanned every creator.
  await prisma.adminAccessLog
    .create({
      data: {
        adminUserId: params.scope.userId,
        workspaceId: params.workspaceId ?? null,
        grantId: params.scope.grantId,
        action: params.action,
        tier: params.scope.tier,
      },
    })
    .catch(() => {});
}
