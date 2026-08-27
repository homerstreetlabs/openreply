/**
 * Which workspace a request acts in, and by what authority.
 *
 * Two callers reach the same routes. A creator, who has exactly one workspace
 * and never names it. And a platform admin, who names someone else's and must
 * leave a record of having done so.
 *
 * Returning a union rather than a bare id is what stops the second case being
 * indistinguishable from the first at the call site. An admin acting in a
 * creator's workspace is a fact worth showing in the UI, and a route that only
 * received a string could not.
 */

import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getCurrentUserId } from "@/lib/auth";
import { assumeWorkspace, PlatformAccessError } from "@/lib/tenancy/platform-scope";

export type ActingWorkspace =
  | { readonly kind: "own"; readonly workspaceId: string }
  | { readonly kind: "assumed"; readonly workspaceId: string; readonly tier: string };

export { PlatformAccessError };

/**
 * Resolve the workspace for this request.
 *
 * `requested` comes from the query string, so it is untrusted. A member of that
 * workspace gets it as their own; anyone else needs a platform grant and is
 * audited. Absent, the caller's own workspace is used and nothing is recorded,
 * because reading your own data is not an access event.
 */
export async function actingWorkspace(
  requested: string | null,
  action: string
): Promise<ActingWorkspace | null> {
  const own = await getCurrentWorkspaceId();
  if (!requested || requested === own) {
    return own ? { kind: "own", workspaceId: own } : null;
  }

  const userId = await getCurrentUserId();
  if (userId) {
    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: requested, userId } },
      select: { workspaceId: true },
    });
    if (membership) return { kind: "own", workspaceId: requested };
  }

  const scope = await assumeWorkspace(requested, action);
  return { kind: "assumed", workspaceId: requested, tier: scope.tier };
}
