import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { acceptCreatorInvitation, type AcceptFailure } from "@/lib/creators/invitations";

export const dynamic = "force-dynamic";

const MESSAGES = {
  not_found:
    "This invitation link is not valid. Ask whoever invited you to send a new one.",
  already_accepted: "This invitation has already been used.",
  expired:
    "This invitation has expired. Ask whoever invited you to send a new one.",
  wrong_email:
    "This invitation was sent to a different email address. Sign in with the address it was sent to.",
} satisfies Record<AcceptFailure, string>;

/**
 * The reason comes back on the query string, so it is untrusted. A guard reads
 * it without asserting, and an unrecognised value shows the page's normal state
 * rather than an empty error.
 */
const FAILURES: readonly AcceptFailure[] = [
  "not_found",
  "already_accepted",
  "expired",
  "wrong_email",
];

function failureMessage(reason: string | undefined): string | null {
  if (!reason) return null;
  const match = FAILURES.find((candidate) => candidate === reason);
  return match ? MESSAGES[match] : null;
}

/**
 * Accepting an invitation is a write, so it needs a button.
 *
 * This page used to call `acceptCreatorInvitation` during its GET render, which
 * created a workspace as a side effect of the page loading. A link prefetch, a
 * mail scanner, or any bot that followed the URL consumed the invitation before
 * the person clicked it.
 */
export default async function JoinPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;
  const session = await auth();

  if (!session?.user?.id || !session.user.email) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/join/${token}`)}`);
  }

  // A read, so the page can name the workspace before anything is created.
  const invitation = await prisma.creatorInvitation.findUnique({
    where: { token },
    select: { email: true, creatorName: true, status: true, expiresAt: true },
  });

  async function accept() {
    "use server";
    const current = await auth();
    if (!current?.user?.id || !current.user.email) {
      redirect(`/login?callbackUrl=${encodeURIComponent(`/join/${token}`)}`);
    }

    const result = await acceptCreatorInvitation({
      token,
      userId: current.user.id,
      userEmail: current.user.email,
    });

    if (!result.ok) redirect(`/join/${token}?error=${result.reason}`);
    redirect("/settings?welcome=1");
  }

  const failure = failureMessage(error);

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-md text-center">
        <h1 className="text-2xl font-semibold text-foreground">OpenReply</h1>

        {failure ? (
          <>
            <p className="mt-4 text-sm text-muted">{failure}</p>
            <Link
              href="/dashboard"
              className="mt-6 inline-block rounded bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
            >
              Go to your dashboard
            </Link>
          </>
        ) : !invitation ? (
          <p className="mt-4 text-sm text-muted">{MESSAGES.not_found}</p>
        ) : invitation.status !== "PENDING" ? (
          <p className="mt-4 text-sm text-muted">{MESSAGES.already_accepted}</p>
        ) : (
          <>
            <p className="mt-4 text-sm text-muted">
              {invitation.creatorName
                ? `${invitation.creatorName}, you have been invited to OpenReply.`
                : "You have been invited to OpenReply."}{" "}
              Accepting creates your own workspace, where you connect your own
              accounts.
            </p>
            <form action={accept} className="mt-6">
              <button
                type="submit"
                className="rounded bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover"
              >
                Accept invitation
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
