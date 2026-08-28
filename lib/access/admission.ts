/**
 * Whether an email address may obtain a session, and by what authority.
 *
 * Registration used to be open. `lib/auth.ts` had no `signIn` callback at all,
 * so any address that submitted the login form received a working magic link
 * and `events.createUser` provisioned it a workspace. `CreatorInvitation`
 * existed but was decoration beside an equally valid ungated front door.
 *
 * This is the only answer to that question in the system. It is read-only and
 * idempotent, because Auth.js calls it twice per sign-in and it must be safe on
 * a retry.
 *
 * It keys on **email, not user id**. For an address it has never seen, Auth.js
 * hands the callback a throwaway `crypto.randomUUID()` user
 * (`@auth/core/lib/actions/signin/send-token.js`), so a gate that looked up a
 * user id would be checking a value that means nothing.
 */

import { prisma } from "@/lib/db/client";

export type AdmissionRefusal =
  | "not_invited"
  | "suspended"
  | "invitation_expired";

export type Admission =
  | { readonly kind: "admin"; readonly userId: string }
  | { readonly kind: "existing"; readonly userId: string }
  | { readonly kind: "creator"; readonly invitationId: string }
  | { readonly kind: "member"; readonly invitationId: string; readonly workspaceId: string }
  | { readonly kind: "bootstrap" }
  | { readonly kind: "refused"; readonly reason: AdmissionRefusal };

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Addresses that may sign in when no platform admin exists yet.
 *
 * Self-disarming: it is consulted only when `PlatformGrant` holds no rows at
 * all, so the moment the first admin is granted this stops being reachable and
 * a stale environment variable cannot become a standing backdoor. It exists
 * because the alternative — a script run against production — needs a shell
 * against production.
 */
function bootstrapAddresses(): string[] {
  return (process.env.BOOTSTRAP_ADMIN_EMAILS ?? "")
    .split(",")
    .map((entry) => normalize(entry))
    .filter((entry) => entry.length > 0);
}

/**
 * Clause order is deliberate and each clause is load-bearing:
 *
 *   1. Suspended refuses, even for an admin. Revoked is revoked.
 *   2. An active grant admits. This is what carries the existing platform
 *      admins through with no data migration; they already hold grants.
 *   3. An existing active user admits. This grandfathers every creator who came
 *      in while the door was open, and it is why revoking a spent invitation is
 *      not how you lock someone out — suspending them is.
 *   4. A pending, unexpired invitation admits, whether creator or workspace
 *      member.
 *   5. The bootstrap allowlist, only when no grant exists anywhere.
 *   6. Otherwise refused.
 */
export async function admit(
  email: string | null | undefined
): Promise<Admission> {
  if (!email) return { kind: "refused", reason: "not_invited" };
  const address = normalize(email);
  const now = new Date();

  const [user, creatorInvite, memberInvite] = await Promise.all([
    prisma.user.findUnique({
      where: { email: address },
      select: {
        id: true,
        status: true,
        platformGrants: {
          where: {
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          select: { id: true },
          take: 1,
        },
      },
    }),
    prisma.creatorInvitation.findFirst({
      where: { email: address, status: "PENDING" },
      select: { id: true, expiresAt: true },
    }),
    prisma.workspaceInvitation.findFirst({
      where: { email: address, status: "PENDING" },
      select: { id: true, workspaceId: true, expiresAt: true },
    }),
  ]);

  if (user?.status === "SUSPENDED") {
    return { kind: "refused", reason: "suspended" };
  }

  if (user && user.platformGrants.length > 0) {
    return { kind: "admin", userId: user.id };
  }

  if (user) {
    return { kind: "existing", userId: user.id };
  }

  if (creatorInvite) {
    if (creatorInvite.expiresAt <= now) {
      return { kind: "refused", reason: "invitation_expired" };
    }
    return { kind: "creator", invitationId: creatorInvite.id };
  }

  if (memberInvite) {
    if (memberInvite.expiresAt <= now) {
      return { kind: "refused", reason: "invitation_expired" };
    }
    return {
      kind: "member",
      invitationId: memberInvite.id,
      workspaceId: memberInvite.workspaceId,
    };
  }

  const allowlist = bootstrapAddresses();
  if (allowlist.includes(address)) {
    const anyGrant = await prisma.platformGrant.findFirst({ select: { id: true } });
    if (!anyGrant) return { kind: "bootstrap" };
  }

  return { kind: "refused", reason: "not_invited" };
}

/**
 * What a completed sign-in owes the person, decided by how they were admitted.
 *
 * Replaces `provisionWorkspaceForSignIn`, which called `ensureWorkspaceForUser`
 * for everybody — the second half of open registration. An admin gets no
 * workspace at all: an operator with a personal workspace shows up in fleet
 * counts and account lists as a creator who does not exist, and
 * `lib/tenancy/platform-scope.ts` already argues that an operator must not
 * appear in a creator's member list.
 *
 * Idempotent. A retried sign-in must not leave anyone with two workspaces.
 */
export async function settleAdmission(
  userId: string,
  email: string | null | undefined
): Promise<void> {
  const admission = await admit(email);
  if (admission.kind === "refused" || admission.kind === "admin") return;

  // Every pending invitation for this address, not just the one `admit`
  // reported. A person invited to two workspaces would otherwise join one and
  // resolve as `existing` on their next sign-in, so the second invitation could
  // never be accepted.
  if (email) {
    await acceptWorkspaceInvitations(userId, normalize(email));
  }

  // A creator's workspace is created by accepting their invitation at
  // /join/[token], which is a deliberate confirmation step rather than a side
  // effect of signing in. This only repairs a session that has no membership at
  // all, which is what the dashboard layout used to do on every render.
  const membership = await prisma.workspaceMember.findFirst({
    where: { userId },
    select: { id: true },
  });
  if (membership) return;

  const { ensureWorkspaceForUser } = await import("@/lib/workspace");
  await ensureWorkspaceForUser(userId, email);
}

/**
 * Idempotent by construction: the upsert converges on the invited role however
 * many times it runs, and an invitation already marked ACCEPTED is not selected
 * again.
 */
async function acceptWorkspaceInvitations(
  userId: string,
  address: string
): Promise<void> {
  const now = new Date();
  const invitations = await prisma.workspaceInvitation.findMany({
    where: { email: address, status: "PENDING", expiresAt: { gt: now } },
    select: { id: true, workspaceId: true, role: true },
  });

  for (const invitation of invitations) {
    await prisma.$transaction([
      prisma.workspaceMember.upsert({
        where: {
          workspaceId_userId: { workspaceId: invitation.workspaceId, userId },
        },
        create: { workspaceId: invitation.workspaceId, userId, role: invitation.role },
        update: { role: invitation.role },
      }),
      prisma.workspaceInvitation.update({
        where: { id: invitation.id },
        data: { status: "ACCEPTED", acceptedAt: now },
      }),
    ]);
  }
}
