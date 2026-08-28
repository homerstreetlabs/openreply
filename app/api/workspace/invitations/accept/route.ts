import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { acceptInvitation, type AcceptFailure } from "@/lib/invitations";

const acceptSchema = z.object({ token: z.string().min(1) });

/**
 * Accepting a workspace invitation, delegated.
 *
 * This route used to re-implement the accept path against its own table,
 * including its own expiry and email checks. There is one accept path now, and
 * `acceptInvitation` owns it for both kinds.
 */
const STATUS: Record<AcceptFailure, number> = {
  not_found: 404,
  already_accepted: 409,
  expired: 410,
  wrong_email: 403,
  workspace_gone: 410,
};

const MESSAGE: Record<AcceptFailure, string> = {
  not_found: "Invitation is no longer available",
  already_accepted: "Invitation has already been used",
  expired: "Invitation has expired",
  wrong_email: "This invitation is for a different email",
  workspace_gone: "That workspace no longer exists",
};

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json(
      { success: false, error: "Sign in with the invited email first" },
      { status: 401 }
    );
  }

  const parsed = acceptSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Missing invitation token" },
      { status: 400 }
    );
  }

  const result = await acceptInvitation({
    token: parsed.data.token,
    userId: session.user.id,
    userEmail: session.user.email,
  });

  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: MESSAGE[result.reason] },
      { status: STATUS[result.reason] }
    );
  }

  return NextResponse.json({
    success: true,
    data: { workspaceName: result.workspaceName },
  });
}
