import { NextRequest, NextResponse } from "next/server";
import { getSessionScope } from "@/lib/session";
import { prisma } from "@/lib/db/client";
import type { Platform } from "@/app/generated/prisma/client";
import {
  calculateCtr,
  countPerDay,
  dailyDmBuckets,
  normalizeTopKeywords,
  summarizeDmStatuses,
} from "@/lib/tracking/analytics";

export const runtime = "nodejs";

/**
 * Exported so the page renders against the type the route actually returns.
 * A field renamed on one side and not the other is invisible across a fetch,
 * which is exactly how the creators page ended up showing email addresses.
 */
export interface DashboardSummary {
  userName: string | null;
  contactsCount: number;
  activeCampaigns: number;
  repliesSent: number;
  directMessages: number;
  publicReplies: number;
  skipped: number;
  failed: number;
  clicksThisMonth: number;
  ctrThisMonth: number;
  topKeywords: { keyword: string; count: number }[];
  dailyRuns: { date: string; count: number }[];
  recentRuns: RecentRun[];
}

export interface RecentRun {
  id: string;
  counterpartyName: string | null;
  triggerText: string;
  status: string;
  createdAt: string;
  dmSentAt: string | null;
  publicReplySentAt: string | null;
  campaign: { name: string };
  connectedAccount: { username: string; platform: Platform };
}

/**
 * The dashboard tiles and chart.
 *
 * Replaces `/api/dashboard/stats`, which computed seven figures nothing read —
 * four of them full counts — on every load, and which Settings also called to
 * reach three unrelated fields.
 *
 * Every count here is workspace-wide across all four platforms and says so.
 * "Replies sent" is deliberately not "DMs sent": the same ledger records
 * YouTube and TikTok public replies, and those platforms have no messaging API
 * to have sent a DM with.
 */
export async function GET(request: NextRequest) {
  const scope = await getSessionScope();
  if (!scope) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const { userId, workspaceId } = scope;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const requested = request.nextUrl.searchParams.get("accountId");
  const accountFilter =
    requested && requested !== "all" ? { connectedAccountId: requested } : {};

  const dayBuckets = dailyDmBuckets(todayStart);
  const chartStart = dayBuckets[0].start;
  const chartEnd = dayBuckets[dayBuckets.length - 1].end;

  const monthScope = { workspaceId, createdAt: { gte: monthStart }, ...accountFilter };

  const [
    user,
    activeCampaigns,
    statusCounts,
    directMessages,
    publicReplies,
    clicksThisMonth,
    deliveredWithLink,
    topKeywordRows,
    contactsCount,
    chartRuns,
    recentRuns,
  ] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } }),
    prisma.campaign.count({ where: { workspaceId, isActive: true, ...accountFilter } }),
    prisma.responseRun.groupBy({
      by: ["status"],
      where: monthScope,
      _count: { _all: true },
    }),
    // The DM / public-reply split beneath the headline. Derived from which
    // timestamp the worker set, which is the same rule `runAction` applies.
    prisma.responseRun.count({
      where: { ...monthScope, status: "SENT", dmSentAt: { not: null } },
    }),
    prisma.responseRun.count({
      where: {
        ...monthScope,
        status: "SENT",
        dmSentAt: null,
        publicReplySentAt: { not: null },
      },
    }),
    prisma.linkClick.count({ where: monthScope }),
    // The CTR denominator: deliveries that actually carried a tracked link.
    // Dividing by every send counts campaigns with no link at all, which drags
    // the rate down for a reason that has nothing to do with the copy.
    prisma.responseRun.count({
      where: {
        ...monthScope,
        status: "SENT",
        campaign: { trackedLinks: { some: {} } },
      },
    }),
    prisma.responseRun.groupBy({
      by: ["matchedKeyword"],
      // Month-scoped, like every neighbouring tile. This was all-time, so a
      // keyword retired in March still topped the list in August.
      where: { ...monthScope, matchedKeyword: { not: null } },
      _count: { _all: true },
    }),
    // A count, not a findMany with `distinct` whose rows were loaded into the
    // Worker only to call `.length` on them.
    prisma.messagingContact.count({
      where: { connectedAccount: { workspaceId } },
    }),
    prisma.responseRun.findMany({
      where: {
        workspaceId,
        status: "SENT",
        createdAt: { gte: chartStart, lt: chartEnd },
        ...accountFilter,
      },
      select: { createdAt: true },
    }),
    prisma.responseRun.findMany({
      where: { workspaceId, ...accountFilter },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        counterpartyName: true,
        triggerText: true,
        status: true,
        createdAt: true,
        dmSentAt: true,
        publicReplySentAt: true,
        campaign: { select: { name: true } },
        connectedAccount: { select: { username: true, platform: true } },
      },
    }),
  ]);

  const monthly = summarizeDmStatuses(
    statusCounts.map((row) => ({ status: row.status, _count: row._count._all }))
  );

  const firstName =
    user?.name?.trim().split(/\s+/)[0] || user?.email?.split("@")[0] || null;

  return NextResponse.json({
    success: true,
    data: {
      userName: firstName,
      contactsCount,
      activeCampaigns,
      repliesSent: monthly.sent,
      directMessages,
      publicReplies,
      skipped: monthly.skipped,
      failed: monthly.failed,
      clicksThisMonth,
      ctrThisMonth: calculateCtr(clicksThisMonth, deliveredWithLink),
      topKeywords: normalizeTopKeywords(
        topKeywordRows.map((row) => ({
          matchedKeyword: row.matchedKeyword,
          _count: row._count._all,
        }))
      ),
      dailyRuns: countPerDay(
        dayBuckets,
        chartRuns.map((run) => run.createdAt)
      ),
      recentRuns,
    },
  });
}
