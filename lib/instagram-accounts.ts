import { prisma } from "@/lib/db/client";

export async function canConnectInstagramAccount({
  workspaceId,
  instagramId,
}: {
  workspaceId: string;
  instagramId: string;
}) {
  const existingAccount = await prisma.connectedAccount.findUnique({
    where: { instagramId },
    select: { workspaceId: true },
  });

  if (existingAccount && existingAccount.workspaceId !== workspaceId) {
    return {
      allowed: false,
      reason: "already_connected" as const,
    };
  }

  return {
    allowed: true,
    reason: null,
  };
}

export async function getWorkspaceInstagramAccount(
  workspaceId: string,
  instagramAccountId?: string | null
) {
  if (instagramAccountId && instagramAccountId !== "all") {
    return prisma.connectedAccount.findFirst({
      where: { id: instagramAccountId, workspaceId },
    });
  }

  return prisma.connectedAccount.findFirst({
    where: { workspaceId },
    orderBy: { connectedAt: "desc" },
  });
}

