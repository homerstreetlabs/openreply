/**
 * Inviting someone, and turning that invitation into access.
 *
 * One table now serves both kinds, which means the nullable `workspaceId` has
 * to be kept honest somewhere. It is kept honest here: these are the only two
 * functions that create an invitation, and each one owns exactly one kind. A
 * caller cannot build a CREATOR invitation with a workspace or a MEMBER
 * invitation without one, because a caller never builds one at all.
 */

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import {
  creatorInvitationEmail,
  sendEmail,
  RecipientSuppressedError,
} from "@/lib/email/send";
import type { WorkspaceRole } from "@/app/generated/prisma/client";

const INVITE_TTL_DAYS = 14;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function newToken(): string {
  return randomBytes(24).toString("base64url");
}

function expiry(): Date {
  const when = new Date();
  when.setDate(when.getDate() + INVITE_TTL_DAYS);
  return when;
}

export function invitationUrl(kind: "CREATOR" | "MEMBER", token: string): string {
  const base = getBaseUrl().replace(/\/$/, "");
  return kind === "CREATOR" ? `${base}/join/${token}` : `${base}/invite/${token}`;
}

export interface InviteResult {
  id: string;
  email: string;
  delivered: boolean;
  deliveryError: string | null;
}

/**
 * Invite a creator, who will get a workspace of their own on accept.
 *
 * Re-inviting the same address replaces the token, which invalidates any link
 * already sent. That is what a resend means, and it is why a leaked old link
 * stops working.
 *
 * Delivery failure does not fail the invitation. The row persists with the
 * error recorded, so an admin can see the address bounced rather than assuming
 * the creator ignored it.
 *
 * Reads before writing rather than upserting: the constraint that stops two
 * creator invitations for one address is a partial unique index, which Prisma
 * cannot target in an upsert.
 */
export async function inviteCreator(params: {
  email: string;
  invitedName?: string | null;
  invitedByUserId: string;
  inviterName?: string | null;
}): Promise<InviteResult> {
  const email = normalizeEmail(params.email);
  const token = newToken();

  const existing = await prisma.invitation.findFirst({
    where: { email, kind: "CREATOR" },
    select: { id: true },
  });

  const invitation = existing
    ? await prisma.invitation.update({
        where: { id: existing.id },
        data: {
          invitedName: params.invitedName ?? undefined,
          token,
          status: "PENDING",
          invitedByUserId: params.invitedByUserId,
          expiresAt: expiry(),
          acceptedAt: null,
          deliveryError: null,
          deliveredAt: null,
        },
      })
    : await prisma.invitation.create({
        data: {
          email,
          kind: "CREATOR",
          invitedName: params.invitedName ?? null,
          token,
          invitedByUserId: params.invitedByUserId,
          expiresAt: expiry(),
        },
      });

  return deliver(invitation.id, email, {
    inviteUrl: invitationUrl("CREATOR", token),
    creatorName: invitation.invitedName,
    inviterName: params.inviterName ?? null,
  });
}

/**
 * Invite someone into a workspace that already exists.
 *
 * Delivery is tracked here too. It never was for workspace invitations, which
 * is why the members route returned a URL for an admin to paste and nobody
 * noticed it sent no mail.
 */
export async function inviteMember(params: {
  email: string;
  workspaceId: string;
  role: WorkspaceRole;
  invitedByUserId: string;
  inviterName?: string | null;
}): Promise<InviteResult> {
  const email = normalizeEmail(params.email);
  const token = newToken();

  const invitation = await prisma.invitation.upsert({
    where: {
      email_kind_workspaceId: {
        email,
        kind: "MEMBER",
        workspaceId: params.workspaceId,
      },
    },
    create: {
      email,
      kind: "MEMBER",
      workspaceId: params.workspaceId,
      role: params.role,
      token,
      invitedByUserId: params.invitedByUserId,
      expiresAt: expiry(),
    },
    update: {
      role: params.role,
      token,
      status: "PENDING",
      invitedByUserId: params.invitedByUserId,
      expiresAt: expiry(),
      acceptedAt: null,
      deliveryError: null,
      deliveredAt: null,
    },
  });

  return deliver(invitation.id, email, {
    inviteUrl: invitationUrl("MEMBER", token),
    creatorName: null,
    inviterName: params.inviterName ?? null,
  });
}

async function deliver(
  invitationId: string,
  email: string,
  content: { inviteUrl: string; creatorName: string | null; inviterName: string | null }
): Promise<InviteResult> {
  try {
    await sendEmail({ to: email, ...creatorInvitationEmail(content) });
    await prisma.invitation.update({
      where: { id: invitationId },
      data: { deliveredAt: new Date(), deliveryError: null },
    });
    return { id: invitationId, email, delivered: true, deliveryError: null };
  } catch (error) {
    const detail =
      error instanceof RecipientSuppressedError
        ? `${email} is suppressed by the mail provider and will not receive mail until it is removed from the suppression list.`
        : error instanceof Error
          ? error.message
          : "Unknown delivery error";

    await prisma.invitation.update({
      where: { id: invitationId },
      data: { deliveryError: detail },
    });
    return { id: invitationId, email, delivered: false, deliveryError: detail };
  }
}

export type AcceptFailure =
  | "not_found"
  | "already_accepted"
  | "expired"
  | "wrong_email"
  | "workspace_gone";

export type AcceptResult =
  | { ok: true; workspaceId: string; workspaceName: string }
  | { ok: false; reason: AcceptFailure };

/**
 * Accept an invitation of either kind.
 *
 * Idempotent. Accepting twice returns what the first accept produced rather
 * than making a second workspace, because a retried request or a double-clicked
 * link must not leave a creator with two.
 */
export async function acceptInvitation(params: {
  token: string;
  userId: string;
  userEmail: string;
}): Promise<AcceptResult> {
  const invitation = await prisma.invitation.findUnique({
    where: { token: params.token },
  });
  if (!invitation) return { ok: false, reason: "not_found" };

  if (invitation.status === "ACCEPTED" && invitation.workspaceId) {
    const existing = await prisma.workspace.findUnique({
      where: { id: invitation.workspaceId },
      select: { id: true, name: true },
    });
    if (existing) {
      return { ok: true, workspaceId: existing.id, workspaceName: existing.name };
    }
  }

  if (invitation.status !== "PENDING") return { ok: false, reason: "already_accepted" };

  if (invitation.expiresAt <= new Date()) {
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: "EXPIRED" },
    });
    return { ok: false, reason: "expired" };
  }

  if (normalizeEmail(params.userEmail) !== invitation.email) {
    return { ok: false, reason: "wrong_email" };
  }

  if (invitation.kind === "MEMBER") {
    // A member invitation can outlive its workspace, because the relation is
    // SetNull so an accepted creator invitation survives a workspace deletion.
    if (!invitation.workspaceId) return { ok: false, reason: "workspace_gone" };

    const workspace = await prisma.workspace.findUnique({
      where: { id: invitation.workspaceId },
      select: { id: true, name: true },
    });
    if (!workspace) return { ok: false, reason: "workspace_gone" };

    await prisma.$transaction([
      prisma.workspaceMember.upsert({
        where: {
          workspaceId_userId: { workspaceId: workspace.id, userId: params.userId },
        },
        create: {
          workspaceId: workspace.id,
          userId: params.userId,
          role: invitation.role ?? "MEMBER",
        },
        update: { role: invitation.role ?? "MEMBER" },
      }),
      prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: "ACCEPTED", acceptedAt: new Date() },
      }),
    ]);

    return { ok: true, workspaceId: workspace.id, workspaceName: workspace.name };
  }

  const name = invitation.invitedName?.trim()
    ? `${invitation.invitedName.trim()}'s workspace`
    : `${invitation.email.split("@")[0]}'s workspace`;

  const workspace = await prisma.workspace.create({
    data: {
      name,
      ownerId: params.userId,
      members: { create: { userId: params.userId, role: "OWNER" } },
    },
    select: { id: true, name: true },
  });

  await prisma.invitation.update({
    where: { id: invitation.id },
    data: { status: "ACCEPTED", acceptedAt: new Date(), workspaceId: workspace.id },
  });

  return { ok: true, workspaceId: workspace.id, workspaceName: workspace.name };
}
