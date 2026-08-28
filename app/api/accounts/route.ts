import { NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/session";
import { accountDirectory } from "@/lib/accounts/directory";

export const runtime = "nodejs";

/**
 * The workspace's connected accounts, for any picker that needs to name one.
 *
 * Replaces `/api/instagram/accounts`, which returned them under a field called
 * `instagramAccounts` regardless of platform. One indexed query, and no
 * analytics aggregation, so a picker is never gated on stats it will not show.
 */
export async function GET() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const directory = await accountDirectory(workspaceId);

  return NextResponse.json({
    success: true,
    data: {
      accounts: directory.all,
      defaultAccountId: directory.all[0]?.id ?? null,
    },
  });
}
