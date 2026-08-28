"use client";

/**
 * Dashboard — tiles, a seven-day chart, and recent activity.
 *
 * Everything here spans every connected account on every platform, which is
 * why the headline is "Replies sent" with a DM / public-reply split beneath it
 * rather than "DMs Sent". YouTube and TikTok have no messaging API, so a run on
 * either could never have been a DM, and the old tile counted them as one.
 */

import { useEffect, useState } from "react";
import DashboardSkeleton from "@/components/dashboard-skeleton";
import StatCard from "@/components/stat-card";
import StatusBadge from "@/components/status-badge";
import { accountLabel } from "@/lib/campaigns/options";
import { runAction } from "@/lib/tracking/activity";
import type { Platform } from "@/app/generated/prisma/client";

interface RecentRun {
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

interface DashboardSummary {
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

export default function DashboardPage() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      fetch("/api/dashboard/summary")
        .then((response) => response.json())
        .then((payload) => {
          if (payload.success) setSummary(payload.data);
        })
        .catch(() => setSummary(null))
        .finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  if (loading) return <DashboardSkeleton />;

  const busiestDay = Math.max(...(summary?.dailyRuns.map((day) => day.count) ?? [1]), 1);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground sm:text-3xl">
          Hello, {summary?.userName ?? "there"}!
        </h1>
        <p className="mt-1 text-sm text-muted">
          {summary?.contactsCount ?? 0}{" "}
          {summary?.contactsCount === 1 ? "person" : "people"} reached ·{" "}
          <a href="/activity" className="text-accent hover:underline">
            See activity
          </a>
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Active campaigns" value={summary?.activeCampaigns ?? 0} />
        <StatCard label="Replies sent" value={summary?.repliesSent ?? 0} />
        <StatCard label="Skipped" value={summary?.skipped ?? 0} />
        <StatCard label="Failed" value={summary?.failed ?? 0} />
        <StatCard label="Clicks" value={summary?.clicksThisMonth ?? 0} />
        <StatCard label="CTR" value={`${summary?.ctrThisMonth ?? 0}%`} />
      </div>

      {/* The split under the headline. Without it "Replies sent" hides that a
          YouTube public reply and an Instagram DM are different things. */}
      <p className="-mt-4 text-xs text-muted">
        This month: {summary?.directMessages ?? 0} direct{" "}
        {summary?.directMessages === 1 ? "message" : "messages"} and{" "}
        {summary?.publicReplies ?? 0} public{" "}
        {summary?.publicReplies === 1 ? "reply" : "replies"}. CTR is clicks against
        deliveries that carried a tracked link.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-6">
        <div className="panel rounded p-4 sm:p-6 lg:col-span-3">
          <h2 className="mb-6 text-sm font-semibold text-foreground">
            Replies — last 7 days
          </h2>
          <div className="flex h-40 items-end gap-1.5 sm:gap-2">
            {summary?.dailyRuns.map((day) => (
              <div
                key={day.date}
                className="flex min-w-0 flex-1 flex-col items-center gap-2"
              >
                <span className="text-xs font-medium text-muted">{day.count}</span>
                <div
                  className="min-h-[4px] w-full rounded-sm bg-accent"
                  style={{ height: `${Math.max((day.count / busiestDay) * 100, 4)}%` }}
                />
                <span className="w-full truncate text-center text-[10px] text-zinc-500">
                  {day.date}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel rounded p-4 sm:p-6 lg:col-span-1">
          <h2 className="mb-4 text-sm font-semibold text-foreground">Top keywords</h2>
          <div className="space-y-3">
            {summary?.topKeywords.length === 0 && (
              <p className="py-8 text-sm text-muted">No keyword matches this month</p>
            )}
            {summary?.topKeywords.map((keyword) => (
              <div
                key={keyword.keyword}
                className="flex items-center justify-between gap-3"
              >
                <span className="truncate text-sm font-medium text-foreground">
                  {keyword.keyword}
                </span>
                <span className="text-xs text-muted">{keyword.count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel rounded p-4 sm:p-6 lg:col-span-2">
          <h2 className="mb-4 text-sm font-semibold text-foreground">Recent activity</h2>
          <div className="max-h-60 space-y-3 overflow-y-auto">
            {summary?.recentRuns.length === 0 && (
              <p className="py-8 text-center text-sm text-muted">No activity yet</p>
            )}
            {summary?.recentRuns.map((run) => (
              <div
                key={run.id}
                className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {run.counterpartyName ?? "unknown"}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {accountLabel(
                      run.connectedAccount.platform,
                      run.connectedAccount.username
                    )}
                    {runAction(run) === "PUBLIC_REPLY" ? " · public reply" : " · DM"} ·{" "}
                    {run.triggerText}
                  </p>
                </div>
                <StatusBadge status={run.status} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
