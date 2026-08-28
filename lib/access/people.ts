/**
 * Who exists on this install, and by what authority.
 *
 * Two role systems meet here and stay separate. `PlatformGrant` is install-wide
 * operator authority; `WorkspaceRole` is a creator's own team. They are
 * deliberately not merged: an operator must be able to act inside a creator's
 * workspace without appearing in that creator's member list, and one enum
 * forces them to either show up there or lose access. What was missing was not
 * a third model but a read model that presents both.
 */

import { prisma } from "@/lib/db/client";
import type { PlatformGrantTier, UserStatus } from "@/app/generated/prisma/client";

export interface PersonView {
  readonly userId: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly status: UserStatus;
  /** Install-wide operator authority. Null for an ordinary creator. */
  readonly grant: {
    readonly id: string;
    readonly tier: PlatformGrantTier;
    readonly grantedAt: Date;
    readonly expiresAt: Date | null;
  } | null;
  /** Their own workspace. A platform admin usually has none, by design. */
  readonly workspace: {
    readonly id: string;
    readonly name: string;
    readonly accounts: number;
  } | null;
  readonly createdAt: Date;
}

export interface PendingInvite {
  readonly id: string;
  readonly email: string;
  readonly kind: "creator" | "member";
  readonly invitedBy: string | null;
  readonly expiresAt: Date;
  readonly deliveredAt: Date | null;
  readonly deliveryError: string | null;
}

export interface People {
  readonly admins: readonly PersonView[];
  readonly creators: readonly PersonView[];
  readonly pending: readonly PendingInvite[];
}

export async function listPeople(): Promise<People> {
  const now = new Date();

  const [users, creatorInvites, memberInvites] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        createdAt: true,
        platformGrants: {
          where: {
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          orderBy: { grantedAt: "desc" },
          take: 1,
          select: { id: true, tier: true, grantedAt: true, expiresAt: true },
        },
        workspaceMembers: {
          orderBy: { createdAt: "asc" },
          take: 1,
          select: {
            workspace: {
              select: {
                id: true,
                name: true,
                _count: { select: { connectedAccounts: true } },
              },
            },
          },
        },
      },
    }),
    prisma.creatorInvitation.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        expiresAt: true,
        deliveredAt: true,
        deliveryError: true,
        invitedBy: { select: { email: true, name: true } },
      },
    }),
    prisma.workspaceInvitation.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        expiresAt: true,
        invitedBy: { select: { email: true, name: true } },
      },
    }),
  ]);

  const people: PersonView[] = users.map((user) => {
    const workspace = user.workspaceMembers[0]?.workspace ?? null;
    return {
      userId: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      grant: user.platformGrants[0] ?? null,
      workspace: workspace
        ? {
            id: workspace.id,
            name: workspace.name,
            accounts: workspace._count.connectedAccounts,
          }
        : null,
      createdAt: user.createdAt,
    };
  });

  return {
    admins: people.filter((person) => person.grant !== null),
    creators: people.filter((person) => person.grant === null),
    pending: [
      ...creatorInvites.map((invite) => ({
        id: invite.id,
        email: invite.email,
        kind: "creator" as const,
        invitedBy: invite.invitedBy?.name ?? invite.invitedBy?.email ?? null,
        expiresAt: invite.expiresAt,
        deliveredAt: invite.deliveredAt,
        deliveryError: invite.deliveryError,
      })),
      ...memberInvites.map((invite) => ({
        id: invite.id,
        email: invite.email,
        kind: "member" as const,
        invitedBy: invite.invitedBy?.name ?? invite.invitedBy?.email ?? null,
        expiresAt: invite.expiresAt,
        deliveredAt: null,
        deliveryError: null,
      })),
    ],
  };
}
