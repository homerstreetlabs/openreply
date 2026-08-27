import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { acceptCreatorInvitation, type AcceptFailure } from "@/lib/creators/invitations";

export const dynamic = "force-dynamic";

const MESSAGES = {
  not_found: "This invitation link is not valid. Ask whoever invited you to send a new one.",
  already_accepted: "This invitation has already been used.",
  expired: "This invitation has expired. Ask whoever invited you to send a new one.",
  wrong_email:
    "This invitation was sent to a different email address. Sign in with the address it was sent to.",
} satisfies Record<AcceptFailure, string>;

export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const session = await auth();

  if (!session?.user?.id || !session.user.email) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/join/${token}`)}`);
  }

  const result = await acceptCreatorInvitation({
    token,
    userId: session.user.id,
    userEmail: session.user.email,
  });

  if (result.ok) {
    redirect("/settings?welcome=1");
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md text-center">
        <h1 className="text-2xl font-semibold text-foreground">OpenReply</h1>
        <p className="mt-4 text-sm text-muted">{MESSAGES[result.reason]}</p>
        <Link
          href="/dashboard"
          className="mt-6 inline-block px-4 py-2 rounded text-sm font-medium bg-accent text-white hover:bg-accent-hover"
        >
          Go to your dashboard
        </Link>
      </div>
    </div>
  );
}
