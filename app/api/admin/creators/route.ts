import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { inviteCreator } from "@/lib/creators/invitations";
import {
  PlatformAccessError,
  recordAdminAccess,
  requirePlatformScope,
} from "@/lib/tenancy/platform-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inviteSchema = z.object({
  email: z.string().email(),
  creatorName: z.string().min(1).max(120).optional(),
});

export async function GET() {
  try {
    await requirePlatformScope("SUPPORT_READ");
    const invitations = await prisma.creatorInvitation.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        email: true,
        creatorName: true,
        status: true,
        deliveredAt: true,
        deliveryError: true,
        expiresAt: true,
        acceptedAt: true,
        createdAt: true,
        workspace: { select: { id: true, name: true } },
      },
    });
    return NextResponse.json({ success: true, data: { invitations } });
  } catch (error) {
    if (error instanceof PlatformAccessError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  try {
    const scope = await requirePlatformScope("ADMIN");
    const parsed = inviteSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid invitation", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const inviter = await prisma.user.findUnique({
      where: { id: scope.userId },
      select: { name: true, email: true },
    });

    await recordAdminAccess({ scope, action: `invited creator ${parsed.data.email}` });

    const result = await inviteCreator({
      email: parsed.data.email,
      creatorName: parsed.data.creatorName ?? null,
      invitedByUserId: scope.userId,
      inviterName: inviter?.name ?? inviter?.email ?? null,
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof PlatformAccessError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    }
    throw error;
  }
}
