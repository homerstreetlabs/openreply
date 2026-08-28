import { prisma } from "@/lib/db/client";
import type { Workspace, WorkspaceRole } from "@/app/generated/prisma/client";

function normalizeInviteEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function acceptPendingInvitationsForUser(
  userId: string,
  email?: string | null
): Promise<void> {
  if (!email) return;

  const normalizedEmail = normalizeInviteEmail(email);
  const now = new Date();
  const invitations = await prisma.workspaceInvitation.findMany({
    where: {
      email: normalizedEmail,
      status: "PENDING",
      expiresAt: { gt: now },
    },
  });

  for (const invitation of invitations) {
    await prisma.$transaction([
      prisma.workspaceMember.upsert({
        where: {
          workspaceId_userId: {
            workspaceId: invitation.workspaceId,
            userId,
          },
        },
        create: {
          workspaceId: invitation.workspaceId,
          userId,
          role: invitation.role,
        },
        update: {
          role: invitation.role,
        },
      }),
      prisma.workspaceInvitation.update({
        where: { id: invitation.id },
        data: {
          status: "ACCEPTED",
          acceptedAt: now,
        },
      }),
    ]);
  }
}

export async function getWorkspaceMembership(userId: string): Promise<{
  workspace: Workspace;
  role: WorkspaceRole;
} | null> {
  const membership = await prisma.workspaceMember.findFirst({
    where: { userId },
    include: { workspace: true },
    orderBy: { createdAt: "asc" },
  });

  if (!membership) return null;

  return {
    workspace: membership.workspace,
    role: membership.role,
  };
}

/**
 * The workspace a user belongs to, creating one only if they have none.
 *
 * Deliberately does not sweep pending invitations. That sweep is a write, and
 * this function is reached from paths that only meant to read; it belongs to
 * signing in, where `provisionWorkspaceForSignIn` runs it.
 */
export async function ensureWorkspaceForUser(
  userId: string,
  email?: string | null
): Promise<Workspace> {
  const existingMembership = await getWorkspaceMembership(userId);
  if (existingMembership) {
    return existingMembership.workspace;
  }

  const workspaceName = email ? `${email.split("@")[0]}'s workspace` : "My workspace";

  return prisma.workspace.create({
    data: {
      name: workspaceName,
      ownerId: userId,
      members: {
        create: {
          userId,
          role: "OWNER",
        },
      },
    },
  });
}

/**
 * Read-only. A page render must be able to ask which workspace a user is in
 * without that question creating one, so this is the half of
 * `ensureWorkspaceForUser` that a GET is allowed to call.
 */
export async function getWorkspaceForUser(userId: string): Promise<Workspace | null> {
  const membership = await getWorkspaceMembership(userId);
  return membership?.workspace ?? null;
}

/**
 * What signing in owes a user: any invitation waiting for their address, then a
 * workspace of their own if they still have none. Order matters — an invited
 * user who is provisioned first would end up with a personal workspace as well
 * as the one they were invited to, and the personal one sorts first.
 *
 * This used to run on every dashboard render, via `ensureWorkspaceForUser`, so
 * every page view paid for an invitation query that almost always returns no
 * rows.
 *
 * ACCEPTED REGRESSION: a user invited during an active session no longer picks
 * the membership up on their next page view; they get it at their next sign-in.
 * The explicit accept path is unaffected and still immediate — `/invite/[token]`
 * and app/api/workspace/invitations/accept/route.ts — which is the route an
 * invitation email actually sends someone down.
 */
export async function provisionWorkspaceForSignIn(
  userId: string,
  email?: string | null
): Promise<Workspace> {
  await acceptPendingInvitationsForUser(userId, email);
  return ensureWorkspaceForUser(userId, email);
}
