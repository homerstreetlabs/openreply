import type { Prisma } from "@/app/generated/prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/session";
import { prisma } from "@/lib/db/client";
import { DmStatus } from "@/app/generated/prisma/client";

/**
 * The status filter arrives from a query string, so it is untrusted. A guard
 * narrows it without asserting, which means an unrecognised value becomes "no
 * filter" rather than a string Prisma rejects at query time.
 */
function parseStatus(value: string | null): DmStatus | null {
  if (!value) return null;
  const statuses: DmStatus[] = Object.values(DmStatus);
  return statuses.find((status) => status === value) ?? null;
}

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const page = Math.max(1, Number.parseInt(searchParams.get("page") ?? "1", 10));
  const limit = Math.min(
    50,
    Math.max(1, Number.parseInt(searchParams.get("limit") ?? "20", 10))
  );
  const status = searchParams.get("status");
  const accountId = searchParams.get("accountId");
  const skip = (page - 1) * limit;
  const parsedStatus = parseStatus(status);

  // Assigned rather than spread. A conditional spread is not excess-property
  // checked, so a stale column name would compile here and fail only when
  // Prisma saw it. Assignment onto a typed object is checked.
  const where: Prisma.ResponseRunWhereInput = { workspaceId };
  if (parsedStatus) where.status = parsedStatus;
  if (accountId && accountId !== "all") {
    where.connectedAccountId = accountId;
  }

  const [logs, total] = await Promise.all([
    prisma.responseRun.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      select: {
        id: true,
        counterpartyId: true,
        counterpartyName: true,
        triggerText: true,
        status: true,
        errorMessage: true,
        createdAt: true,
        dmSentAt: true,
        publicReplySentAt: true,
        campaign: { select: { name: true, keywords: true } },
        connectedAccount: { select: { username: true, platform: true } },
      },
    }),
    prisma.responseRun.count({ where }),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    },
  });
}
