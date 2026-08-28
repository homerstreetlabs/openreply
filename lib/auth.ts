import NextAuth, { type NextAuthConfig } from "next-auth";
import Nodemailer from "next-auth/providers/nodemailer";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db/client";
import { admit, settleAdmission } from "@/lib/access/admission";
import { sendEmail, RecipientSuppressedError as TransportSuppressed } from "@/lib/email/send";

type AdapterPrismaClient = Parameters<typeof PrismaAdapter>[0];

const emailFrom = process.env.EMAIL_FROM ?? "OpenReply <login@example.com>";

/**
 * Provider id the login form signs in with. One transport now, but the login
 * page should not hardcode the string.
 */
export const EMAIL_PROVIDER_ID = "nodemailer";

/**
 * Re-exported so the login page has one error to catch.
 *
 * Cloudflare suppresses an address account-wide after a single spam complaint
 * and rate-limits removal, so an unhandled suppression is a silent permanent
 * lockout: the user asks for a link, we report success, and no mail arrives.
 * The transport raises it; this names it where the login page looks.
 */
export const RecipientSuppressedError = TransportSuppressed;

export const authConfig = {
  // SAFETY: the adapter reads the delegate methods this client exposes. The
  // double assertion is required because Auth.js types its client against its
  // own vendored Prisma types, which are structurally unrelated to ours.
  adapter: PrismaAdapter(prisma as unknown as AdapterPrismaClient),
  providers: [
    Nodemailer({
      // Unused. `sendVerificationRequest` below is fully overridden and routes
      // through the shared transport, which prefers the Cloudflare binding. The
      // provider still requires the field, so it is only a placeholder when no
      // SMTP fallback is configured.
      server: process.env.EMAIL_SERVER ?? "smtp://unused",
      from: emailFrom,
      async sendVerificationRequest({ identifier, url }) {
        const { host } = new URL(url);
        // One transport for magic links and creator invitations, so a mail
        // configuration that works for one cannot fail for the other.
        await sendEmail({
          to: identifier,
          subject: `Sign in to ${host}`,
          text: `Sign in to ${host}\n${url}\n\nThis link expires in 24 hours.\n`,
          html: `<body><p>Sign in to <strong>${host}</strong></p><p><a href="${url}">Sign in</a></p><p>This link expires in 24 hours. If you did not request it, ignore this email.</p></body>`,
        });
      },
    }),
  ],
  callbacks: {
    /**
     * The registration gate.
     *
     * Auth.js calls this twice per sign-in, and each call precedes the side
     * effect it has to prevent: once before the verification token is generated
     * and the mail is sent, and again before `adapter.createUser`. So refusing
     * here means an uninvited address produces no token, no email, and no user
     * row — rather than an account that is created and then denied.
     */
    async signIn({ user }) {
      const admission = await admit(user.email);
      return admission.kind !== "refused";
    },

    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  events: {
    /**
     * What signing in owes the user now depends on how they were admitted, so
     * this is no longer "provision a workspace for everybody" — that was the
     * second half of open registration. A platform admin gets none.
     */
    async signIn({ user }) {
      if (user.id) {
        await settleAdmission(user.id, user.email);
      }
    },
  },
  pages: {
    signIn: "/login",
    verifyRequest: "/verify-request",
  },
  session: {
    strategy: "database",
  },
  trustHost: true,
  secret: process.env.NEXTAUTH_SECRET,
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
