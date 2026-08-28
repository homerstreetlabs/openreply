import NextAuth, { type NextAuthConfig } from "next-auth";
import Nodemailer from "next-auth/providers/nodemailer";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db/client";
import { provisionWorkspaceForSignIn } from "@/lib/workspace";
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
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  events: {
    async createUser({ user }) {
      if (user.id) {
        await provisionWorkspaceForSignIn(user.id, user.email);
      }
    },
    // See provisionWorkspaceForSignIn for the regression this accepts and why
    // the explicit accept route covers it.
    async signIn({ user }) {
      if (user.id) {
        await provisionWorkspaceForSignIn(user.id, user.email);
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
