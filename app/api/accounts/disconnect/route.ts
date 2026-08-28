import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

/**
 * Disconnect one connected account, on any platform.
 *
 * The id is required. The old route treated a missing id as "delete every
 * account in the workspace", which is a destructive default reachable by
 * sending an empty body.
 */
const disconnectSchema = z.object({ accountId: z.string().min(1) });

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can disconnect accounts" },
      { status: 403 }
    );
  }

  const parsed = disconnectSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "An account is required" },
      { status: 400 }
    );
  }

  const removed = await prisma.connectedAccount.deleteMany({
    where: { id: parsed.data.accountId, workspaceId: context.workspaceId },
  });

  if (removed.count === 0) {
    return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
