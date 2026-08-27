/**
 * Inviting a UGC creator, and turning that invitation into their own workspace.
 *
 * Distinct from workspace invitations, which add a person to a workspace that
 * already exists. This one creates the workspace, so the creator lands in a
 * space that is theirs and connects their own accounts to it.
 *
 * `inviteCreator` sends the email itself rather than returning a URL. The
 * existing workspace-invite route returns an `inviteUrl` for an admin to paste
 * somewhere, and that became the only thing anyone used, which is why nobody
 * ever noticed it never sent mail.
 */

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { creatorInvitationEmail, sendEmail, RecipientSuppressedError } from "@/lib/email/send";

const INVITE_TTL_DAYS = 14;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function newToken(): string {
  return randomBytes(24).toString("base64url");
}

function expiry(): Date {
  const d = new Date();
  d.setDate(d.getDate() + INVITE_TTL_DAYS);
  return d;
}

function creatorInviteUrl(token: string): string {
  return `${getBaseUrl().replace(/\/$/, "")}/join/${token}`;
}

export interface InviteResult {
  id: string;
  email: string;
  delivered: boolean;
  deliveryError: string | null;
}

/**
 * Create or refresh an invitation and send it.
 *
 * Re-inviting the same address replaces the token, which invalidates any link
 * already sent. That is the intended behaviour for a resend, and it means a
 * leaked old link stops working.
 *
 * Delivery failure does not fail the invitation. The row persists with the
 * error recorded so an admin can see the address bounced rather than assuming
 * the creator ignored it.
 */
export async function inviteCreator(params: {
  email: string;
  creatorName?: string | null;
  invitedByUserId: string;
  inviterName?: string | null;
}): Promise<InviteResult> {
  const email = normalizeEmail(params.email);
  const token = newToken();

  const invitation = await prisma.creatorInvitation.upsert({
    where: { email },
    create: {
      email,
      creatorName: params.creatorName ?? null,
      token,
      invitedByUserId: params.invitedByUserId,
      expiresAt: expiry(),
    },
    update: {
      creatorName: params.creatorName ?? undefined,
      token,
      status: "PENDING",
      invitedByUserId: params.invitedByUserId,
      expiresAt: expiry(),
      acceptedAt: null,
      deliveryError: null,
      deliveredAt: null,
    },
  });

  try {
    await sendEmail({
      to: email,
      ...creatorInvitationEmail({
        inviteUrl: creatorInviteUrl(token),
        creatorName: invitation.creatorName,
        inviterName: params.inviterName ?? null,
      }),
    });
    await prisma.creatorInvitation.update({
      where: { id: invitation.id },
      data: { deliveredAt: new Date(), deliveryError: null },
    });
    return { id: invitation.id, email, delivered: true, deliveryError: null };
  } catch (error) {
    const detail =
      error instanceof RecipientSuppressedError
        ? `${email} is suppressed by the mail provider and will not receive mail until it is removed from the suppression list.`
        : error instanceof Error
          ? error.message
          : "Unknown delivery error";

    await prisma.creatorInvitation.update({
      where: { id: invitation.id },
      data: { deliveryError: detail },
    });
    return { id: invitation.id, email, delivered: false, deliveryError: detail };
  }
}

export type AcceptFailure =
  | "not_found"
  | "already_accepted"
  | "expired"
  | "wrong_email";

export type AcceptResult =
  | { ok: true; workspaceId: string; workspaceName: string }
  | { ok: false; reason: AcceptFailure };

/**
 * Accept an invitation and provision the creator's workspace.
 *
 * Idempotent. Accepting twice returns the workspace the first accept created
 * rather than making a second one, because a retried request or a double-clicked
 * link must not leave a creator with two spaces.
 */
export async function acceptCreatorInvitation(params: {
  token: string;
  userId: string;
  userEmail: string;
}): Promise<AcceptResult> {
  const invitation = await prisma.creatorInvitation.findUnique({
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
    await prisma.creatorInvitation.update({
      where: { id: invitation.id },
      data: { status: "EXPIRED" },
    });
    return { ok: false, reason: "expired" };
  }

  if (normalizeEmail(params.userEmail) !== invitation.email) {
    return { ok: false, reason: "wrong_email" };
  }

  const name = invitation.creatorName?.trim()
    ? `${invitation.creatorName.trim()}'s workspace`
    : `${invitation.email.split("@")[0]}'s workspace`;

  const workspace = await prisma.workspace.create({
    data: {
      name,
      ownerId: params.userId,
      members: { create: { userId: params.userId, role: "OWNER" } },
    },
    select: { id: true, name: true },
  });

  await prisma.creatorInvitation.update({
    where: { id: invitation.id },
    data: { status: "ACCEPTED", acceptedAt: new Date(), workspaceId: workspace.id },
  });

  return { ok: true, workspaceId: workspace.id, workspaceName: workspace.name };
}
