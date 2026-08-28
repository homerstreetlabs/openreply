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

import { prisma } from "@/lib/db/client";
import { getSessionScope } from "@/lib/session";
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
  // Both halves of the session come from one lookup. Routes are where this is
  // called, and React memoization does not apply there, so asking twice would
  // genuinely be two session queries.
  const session = await getSessionScope();
  if (!requested || requested === session?.workspaceId) {
    return session ? { kind: "own", workspaceId: session.workspaceId } : null;
  }

  if (session) {
    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: requested, userId: session.userId },
      },
      select: { workspaceId: true },
    });
    if (membership) return { kind: "own", workspaceId: requested };
  }

  const scope = await assumeWorkspace(requested, action, session?.userId);
  return { kind: "assumed", workspaceId: requested, tier: scope.tier };
}
