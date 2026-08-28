import { NextRequest, NextResponse } from "next/server";
import { getSessionScope } from "@/lib/session";
import { prisma } from "@/lib/db/client";
import {
  calculateCtr,
  countPerDay,
  dailyDmBuckets,
  normalizeTopKeywords,
  summarizeDmStatuses,
} from "@/lib/tracking/analytics";

export async function GET(request: NextRequest) {
  const scope = await getSessionScope();
  if (!scope) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  const { userId, workspaceId } = scope;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 7);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const requestedInstagramAccountId =
    request.nextUrl.searchParams.get("accountId");
  const selectedAccountId =
    requestedInstagramAccountId && requestedInstagramAccountId !== "all"
      ? requestedInstagramAccountId
      : null;
  const accountFilter: { connectedAccountId?: string } = selectedAccountId
    ? { connectedAccountId: selectedAccountId }
    : {};

  const dayBuckets = dailyDmBuckets(todayStart);
  const chartWindowStart = dayBuckets[0].start;
  const chartWindowEnd = dayBuckets[dayBuckets.length - 1].end;

  const [
    workspace,
    instagramAccount,
    instagramAccounts,
    totalAutomations,
    activeAutomations,
    dmsSentToday,
    dmsSentWeek,
    dmsSentMonth,
    totalDMs,
    dmStatusCountsThisMonth,
    clicksThisMonth,
    totalClicks,
    topKeywordRows,
    recentLogs,
    user,
    contactRows,
    sentThisChartWindow,
  ] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        name: true,
        dmsSentThisPeriod: true,
      },
    }),
    prisma.connectedAccount.findFirst({
      where: { workspaceId },
      orderBy: { connectedAt: "desc" },
      select: {
        id: true,
        username: true,
        instagramId: true,
        tokenExpiresAt: true,
        webhookSubscribed: true,
      },
    }),
    prisma.connectedAccount.findMany({
      where: { workspaceId },
      orderBy: { connectedAt: "desc" },
      select: {
        id: true,
        username: true,
        instagramId: true,
        name: true,
        platform: true,
        tokenExpiresAt: true,
        webhookSubscribed: true,
      },
    }),
    prisma.campaign.count({ where: { workspaceId, ...accountFilter } }),
    prisma.campaign.count({
      where: { workspaceId, isActive: true, ...accountFilter },
    }),
    prisma.responseRun.count({
      where: {
        workspaceId,
        status: "SENT",
        createdAt: { gte: todayStart },
        ...accountFilter,
      },
    }),
    prisma.responseRun.count({
      where: {
        workspaceId,
        status: "SENT",
        createdAt: { gte: weekStart },
        ...accountFilter,
      },
    }),
    prisma.responseRun.count({
      where: {
        workspaceId,
        status: "SENT",
        createdAt: { gte: monthStart },
        ...accountFilter,
      },
    }),
    prisma.responseRun.count({
      where: { workspaceId, status: "SENT", ...accountFilter },
    }),
    prisma.responseRun.groupBy({
      by: ["status"],
      where: { workspaceId, createdAt: { gte: monthStart }, ...accountFilter },
      _count: { _all: true },
    }),
    prisma.linkClick.count({
      where: { workspaceId, createdAt: { gte: monthStart }, ...accountFilter },
    }),
    prisma.linkClick.count({ where: { workspaceId, ...accountFilter } }),
    prisma.responseRun.groupBy({
      by: ["matchedKeyword"],
      where: { workspaceId, matchedKeyword: { not: null }, ...accountFilter },
      _count: { _all: true },
    }),
    prisma.responseRun.findMany({
      where: { workspaceId, ...accountFilter },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: {
        campaign: { select: { name: true } },
        connectedAccount: { select: { username: true } },
      },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    }),
    // Distinct people who have interacted, counted as "contacts".
    prisma.responseRun.findMany({
      where: { workspaceId, ...accountFilter },
      distinct: ["counterpartyId"],
      select: { counterpartyId: true },
    }),
    prisma.responseRun.findMany({
      where: {
        workspaceId,
        status: "SENT",
        createdAt: { gte: chartWindowStart, lt: chartWindowEnd },
        ...accountFilter,
      },
      select: { createdAt: true },
    }),
  ]);

  const dailyDMs = countPerDay(
    dayBuckets,
    sentThisChartWindow.map((run) => run.createdAt)
  );

  const monthlyStatusSummary = summarizeDmStatuses(
    dmStatusCountsThisMonth.map((row) => ({
      status: row.status,
      _count: row._count._all,
    }))
  );
  const topKeywords = normalizeTopKeywords(
    topKeywordRows.map((row) => ({
      matchedKeyword: row.matchedKeyword,
      _count: row._count._all,
    }))
  );

  const firstName =
    user?.name?.trim().split(/\s+/)[0] ||
    user?.email?.split("@")[0] ||
    null;

  return NextResponse.json({
    success: true,
    data: {
      userName: firstName,
      contactsCount: contactRows.length,
      workspace,
      instagramAccount,
      instagramAccounts,
      selectedInstagramAccountId: selectedAccountId,
      totalAutomations,
      activeAutomations,
      dmsSentToday,
      dmsSentWeek,
      dmsSentMonth,
      dmsSkippedMonth: monthlyStatusSummary.skipped,
      dmsFailedMonth: monthlyStatusSummary.failed,
      totalDMs,
      clicksThisMonth,
      totalClicks,
      ctrThisMonth: calculateCtr(clicksThisMonth, dmsSentMonth),
      topKeywords,
      dailyDMs,
      recentLogs,
    },
  });
}
