"use client";

/**
 * Activity — every campaign run, across every connected account.
 *
 * This is the one surface that deliberately aggregates. A run is a run on any
 * platform, so these rows are comparable in a way that reach and views are not,
 * which is why Overview stays per-account and this does not.
 *
 * It was called "DM Logs" and filtered on DM statuses, while the ledger behind
 * it also records YouTube and TikTok public replies on platforms with no
 * messaging API at all.
 */

import { useCallback, useEffect, useState } from "react";
import StatusBadge from "@/components/status-badge";
import { accountLabel } from "@/lib/campaigns/options";
import { runAction } from "@/lib/tracking/activity";
import type { Platform } from "@/app/generated/prisma/client";

interface ActivityRun {
  id: string;
  counterpartyId: string;
  counterpartyName: string | null;
  triggerText: string;
  status: string;
  errorMessage: string | null;
  createdAt: string;
  dmSentAt: string | null;
  publicReplySentAt: string | null;
  campaign: { name: string; keywords: string[] };
  connectedAccount: { username: string; platform: Platform };
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const STATUS_FILTERS = [
  "ALL",
  "SENT",
  "FAILED",
  "PENDING",
  "SKIPPED_RATE_LIMIT",
  "SKIPPED_PLAN_LIMIT",
  "SKIPPED_DEDUP",
];

const ACTION_LABELS = {
  DIRECT_MESSAGE: "DM",
  PUBLIC_REPLY: "Public reply",
} as const;

export default function ActivityPage() {
  const [runs, setRuns] = useState<ActivityRun[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [page, setPage] = useState(1);

  const fetchRuns = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (statusFilter !== "ALL") params.set("status", statusFilter);

      const response = await fetch(`/api/activity?${params}`);
      const payload = await response.json();
      if (payload.success) {
        setRuns(payload.data.logs);
        setPagination(payload.data.pagination);
      }
    } catch {
      // The table keeps whatever it last showed rather than blanking.
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchRuns(), 0);
    return () => window.clearTimeout(timer);
  }, [fetchRuns]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Activity</h1>
        <p className="mt-1 text-sm text-muted">
          Every campaign run across all your connected accounts.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((status) => (
          <button
            key={status}
            onClick={() => {
              setLoading(true);
              setStatusFilter(status);
              setPage(1);
            }}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
              statusFilter === status
                ? "border border-accent/20 bg-accent/15 text-accent"
                : "border border-border bg-surface text-muted hover:border-border-hover hover:text-foreground"
            }`}
          >
            {status === "ALL"
              ? "All"
              : status.replace("SKIPPED_", "").replace("_", " ")}
          </button>
        ))}
      </div>

      <div className="panel overflow-hidden rounded">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                {["Person", "Comment", "Campaign", "Account", "Action", "Status", "Time"].map(
                  (heading) => (
                    <th
                      key={heading}
                      className="px-4 py-4 text-xs font-semibold uppercase tracking-wider text-muted sm:px-6"
                    >
                      {heading}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading &&
                [...Array(5)].map((_, index) => (
                  <tr key={index}>
                    <td colSpan={7} className="px-4 py-4 sm:px-6">
                      <div className="h-4 rounded bg-surface-hover" />
                    </td>
                  </tr>
                ))}
              {!loading && runs.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-muted sm:px-6">
                    No activity yet
                  </td>
                </tr>
              )}
              {!loading &&
                runs.map((run) => (
                  <tr key={run.id} className="transition-colors hover:bg-surface-hover/50">
                    <td className="px-4 py-4 sm:px-6">
                      <span className="font-medium text-foreground">
                        {run.counterpartyName ?? run.counterpartyId.slice(0, 8)}
                      </span>
                    </td>
                    <td className="max-w-[200px] px-4 py-4 sm:px-6">
                      <span className="block truncate text-muted">{run.triggerText}</span>
                    </td>
                    <td className="px-4 py-4 text-muted sm:px-6">{run.campaign.name}</td>
                    <td className="px-4 py-4 text-muted sm:px-6">
                      {/* A Page is not a handle. Prefixing every platform with
                          "@" printed "@Acme Bakery". */}
                      {accountLabel(
                        run.connectedAccount.platform,
                        run.connectedAccount.username
                      )}
                    </td>
                    <td className="px-4 py-4 sm:px-6">
                      <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">
                        {ACTION_LABELS[runAction(run)]}
                      </span>
                    </td>
                    <td className="px-4 py-4 sm:px-6">
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-4 text-muted sm:px-6">
                      {new Date(run.createdAt).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {pagination && pagination.totalPages > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-4 sm:px-6">
            <p className="text-xs text-muted">
              Showing {(pagination.page - 1) * pagination.limit + 1}–
              {Math.min(pagination.page * pagination.limit, pagination.total)} of{" "}
              {pagination.total}
            </p>
            <div className="flex items-center gap-2">
              <button
                disabled={page <= 1}
                onClick={() => {
                  setLoading(true);
                  setPage(page - 1);
                }}
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition-all hover:border-border-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              >
                Previous
              </button>
              <span className="px-2 text-xs text-muted">
                {page} / {pagination.totalPages}
              </span>
              <button
                disabled={page >= pagination.totalPages}
                onClick={() => {
                  setLoading(true);
                  setPage(page + 1);
                }}
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition-all hover:border-border-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
