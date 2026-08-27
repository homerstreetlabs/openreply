/**
 * Creator self-enrollment.
 *
 * Today's `WorkspaceInvitation` invites a COLLABORATOR into an EXISTING
 * workspace, and `POST /api/workspace/members` never sends an email — it
 * returns a URL for an admin to copy-paste. Neither fact fits the requirement:
 * "we invite a UGC creator by email; they get an account and connect their own
 * social accounts themselves."
 *
 * A creator invitation is a different thing with different invariants: it
 * PROVISIONS a workspace rather than joining one, and the invitee becomes its
 * OWNER. Overloading the existing model with a flag would put two lifecycles
 * behind one status enum. Two models, one shared acceptance path.
 */

import type { PlatformScope, WorkspaceRole } from "./scope";

export interface CreatorInvitation {
  readonly id: string;
  readonly email: string;
  /** Pre-names the workspace so the creator lands somewhere already labelled. */
  readonly creatorName: string;
  readonly token: string;
  readonly status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
  readonly invitedByUserId: string;
  /** Platforms this creator is expected to connect. Drives the onboarding checklist. */
  readonly expectedPlatforms: readonly string[];
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly workspaceId: string | null;
}

/**
 * Create the invitation AND send the email, in that order, in one call.
 * Splitting them is what produced today's silent copy-paste gap — a route that
 * creates an invitation and returns a URL is a route that will one day be the
 * only thing anyone calls.
 *
 * The send goes through `email-queue` rather than inline, because Cloudflare
 * Email Sending's daily quota and rate limit are UNPUBLISHED ("New accounts
 * start with a conservative daily quota"), so a bulk invite must drain at a
 * controlled rate rather than half-fail.
 */
export async function inviteCreator(
  admin: PlatformScope,
  input: {
    readonly email: string;
    readonly creatorName: string;
    readonly expectedPlatforms: readonly string[];
  }
): Promise<CreatorInvitation> {
  throw new Error("not implemented");
}

/**
 * Accept, provisioning the workspace. Idempotent by invitation id: a
 * double-click, a retried email link, or a race between two tabs produces one
 * workspace. The `workspaceId` written back onto the invitation is what makes
 * it so — a second acceptance finds it set and returns the same workspace.
 *
 * Runs inside the Auth.js `events.createUser` hook as well as on the accept
 * route, so a creator who clicks the magic link before the invite link still
 * lands correctly. That mirrors today's `acceptPendingInvitationsForUser`,
 * which is already wired that way.
 */
export async function acceptCreatorInvitation(
  token: string,
  userId: string,
  userEmail: string
): Promise<{ readonly workspaceId: string }> {
  throw new Error("not implemented");
}

// ─── Transactional email ─────────────────────────────────────────────────────

/**
 * Cloudflare Email Sending. PUBLIC BETA, Workers Paid only, and it can send to
 * arbitrary recipients only AFTER a sending domain is onboarded — before that,
 * only to verified destination addresses. That is account state, not binding
 * config, so it is verified empirically in staging before any creator invite
 * goes out.
 */
export interface EmailSender {
  send(msg: {
    readonly to: string;
    readonly subject: string;
    readonly html: string;
    readonly text: string;
  }): Promise<{ readonly messageId: string }>;
}

/**
 * `env.EMAIL.send({ to, from: { email, name }, subject, html, text, replyTo })`.
 * Note the REST API drifts: `from.address` not `from.email`, `reply_to` not
 * `replyTo`. The binding form is the one used here.
 */
export function cloudflareEmailSender(binding: unknown): EmailSender {
  throw new Error("not implemented");
}

/**
 * Auth.js magic links stay on the EXISTING Nodemailer branch, over Cloudflare's
 * authenticated SMTP:
 *
 *   EMAIL_SERVER="smtps://api_token:<CF_API_TOKEN>@smtp.mx.cloudflare.net:465"
 *
 * `lib/auth.ts` already switches to Nodemailer when `EMAIL_SERVER` is set and
 * derives `EMAIL_PROVIDER_ID` from it, so this is one environment variable and
 * zero code change — and Resend stays one variable away as a rollback. That
 * matters because this is the LOGIN path and the service is in beta.
 *
 * Port 465, implicit TLS only. The username is the literal string `api_token`.
 */
export const CLOUDFLARE_SMTP_HINT =
  "smtps://api_token:<CF_API_TOKEN>@smtp.mx.cloudflare.net:465";

/**
 * Bounces and complaints arrive on a QUEUE, not an HTTP webhook. One spam
 * complaint auto-suppresses that address ACCOUNT-WIDE, so an unhandled
 * `E_RECIPIENT_SUPPRESSED` is a silent permanent login lockout for that user —
 * the failure would look like "magic links stopped working for one customer"
 * with nothing in any log we own.
 *
 * Handling: raise an `EMAIL_SUPPRESSED` incident against the user, show an
 * explicit message on the login page instead of the usual "check your inbox",
 * and give platform admins a one-click resend-via-alternate path.
 */
export async function handleEmailEvent(event: {
  readonly type: "bounce" | "complaint" | "delivered";
  readonly recipient: string;
  readonly code: string | null;
}): Promise<void> {
  throw new Error("not implemented");
}

/** Roles a creator invitation may grant. Always OWNER; the type says so. */
export const CREATOR_INVITE_ROLE: WorkspaceRole = "OWNER";
