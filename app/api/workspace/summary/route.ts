import { NextResponse } from "next/server";
import { getSessionScope } from "@/lib/session";
import { prisma } from "@/lib/db/client";
import { accountLabel } from "@/lib/campaigns/options";

export const runtime = "nodejs";

/**
 * What Settings needs, and nothing else.
 *
 * Settings used to call `/api/dashboard/stats` and pay for its whole analytics
 * aggregation — seventeen queries — to read a usage figure and two per-account
 * flags.
 */
export async function GET() {
  const scope = await getSessionScope();
  if (!scope) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const [workspace, accounts] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: scope.workspaceId },
      select: { name: true, dmsSentThisPeriod: true },
    }),
    prisma.connectedAccount.findMany({
      where: { workspaceId: scope.workspaceId },
      orderBy: [{ platform: "asc" }, { connectedAt: "desc" }],
      select: {
        id: true,
        platform: true,
        username: true,
        tokenExpiresAt: true,
        webhookSubscribed: true,
      },
    }),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      workspace,
      accounts: accounts.map((account) => ({
        id: account.id,
        platform: account.platform,
        label: accountLabel(account.platform, account.username),
        tokenExpiresAt: account.tokenExpiresAt,
        webhookSubscribed: account.webhookSubscribed,
      })),
    },
  });
}
