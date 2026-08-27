/**
 * Transactional email, through the Cloudflare binding where there is one.
 *
 * A Worker cannot SMTP to Cloudflare's own relay. The Workers socket layer
 * refuses Cloudflare IPs the same way it refuses localhost and private
 * addresses, so `smtps://smtp.mx.cloudflare.net:465` fails from inside a Worker
 * with "cannot connect to the specified address". That bridge is for clients
 * that are not Workers, which is why the recipe works from a laptop and not
 * from here.
 *
 * So the binding wins where one is bound, and SMTP remains the fallback for
 * scripts, tests and `next dev`, which are not Workers and can reach it.
 *
 * Cloudflare suppresses an address account-wide after a single spam complaint
 * and rate-limits removal. An unhandled suppression is therefore a silent dead
 * end, where we report success and no mail ever arrives, so it is surfaced as a
 * distinct error the caller can record and show.
 */

import { requireEnv } from "@/lib/env";
import { tryBindings } from "@/lib/cloudflare/bindings";

export class RecipientSuppressedError extends Error {
  constructor(readonly email: string) {
    super(
      `${email} is suppressed by the mail provider and cannot receive mail. ` +
        `It must be removed from the suppression list first.`
    );
    this.name = "RecipientSuppressedError";
  }
}

const SUPPRESSED = /E_RECIPIENT_SUPPRESSED|recipient.*suppress|suppressed.*recipient/i;

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * The sender.
 *
 * Cloudflare rejects a sender outside the domain you onboarded, and the
 * placeholder is on a domain nobody owns. Required rather than defaulted, so a
 * missing value fails at the send with the variable name rather than at the
 * provider with a message about the address.
 */
function sender(): string {
  return requireEnv("EMAIL_FROM");
}

export async function sendEmail(email: Email): Promise<void> {
  const binding = tryBindings()?.EMAIL;

  try {
    if (binding) {
      await binding.send({ ...email, from: sender() });
      return;
    }
    await sendOverSmtp(email);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (SUPPRESSED.test(message)) throw new RecipientSuppressedError(email.to);
    throw error;
  }
}

/** Off a Worker there is no binding, and the SMTP bridge is reachable. */
async function sendOverSmtp(email: Email): Promise<void> {
  const { createTransport } = await import("nodemailer");
  const transport = createTransport(requireEnv("EMAIL_SERVER"));

  const result = await transport.sendMail({ ...email, from: sender() });
  const rejected = [...result.rejected, ...(result.pending ?? [])].filter(Boolean);
  if (rejected.length > 0) {
    throw new Error(`Email rejected for ${rejected.join(", ")}`);
  }
}

export function creatorInvitationEmail(params: {
  inviteUrl: string;
  creatorName?: string | null;
  inviterName?: string | null;
}): Omit<Email, "to"> {
  const greeting = params.creatorName ? `Hi ${params.creatorName},` : "Hi,";
  const from = params.inviterName ? `${params.inviterName} has` : "You have been";
  const subject = "You have been invited to OpenReply";

  return {
    subject,
    text: [
      greeting,
      "",
      `${from} invited you to connect your social accounts to OpenReply.`,
      "",
      "Once you accept you can connect your own Instagram and Facebook accounts,",
      "and set up automatic replies to people who comment on your posts and Reels.",
      "",
      params.inviteUrl,
      "",
      "This link expires in 14 days.",
      "",
    ].join("\n"),
    html: `<body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#111">
  <p>${greeting}</p>
  <p>${from} invited you to connect your social accounts to OpenReply.</p>
  <p>Once you accept you can connect your own Instagram and Facebook accounts, and set up automatic replies to people who comment on your posts and Reels.</p>
  <p><a href="${params.inviteUrl}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;border-radius:6px;text-decoration:none">Accept the invitation</a></p>
  <p style="color:#666;font-size:14px">This link expires in 14 days. If you were not expecting it, you can ignore this email.</p>
</body>`,
  };
}
