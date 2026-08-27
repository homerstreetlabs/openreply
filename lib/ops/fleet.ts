/**
 * The cross-creator health view.
 *
 * Cloudflare Notifications has no Workers alert type at all. There is no
 * alerting on Worker error rate, queue backlog, or a failed cron. So this is not
 * a dashboard bolted on top of the send path, it is the alerting system, and it
 * has to answer "what is broken and why" without a human going looking.
 *
 * Read straight from the ledger rather than a scan of every run. The dominant
 * question is "every account across every creator, worst first", and the run
 * status column already carries the answer.
 */

import { prisma } from "@/lib/db/client";
import { readSendingLimits } from "@/lib/email/limits";
import type { IncidentKind, IncidentSeverity, Platform } from "@/app/generated/prisma/client";
import type { PlatformScope } from "@/lib/tenancy/platform-scope";

export type AccountStatus = "HEALTHY" | "DEGRADED" | "BROKEN";

export interface FailureReason {
  reason: string;
  count: number;
  lastSeenAt: Date;
  /** True when the reason was withheld because the viewer cannot read content. */
  redacted?: boolean;
}

export interface FleetAccountRow {
  connectedAccountId: string;
  workspaceId: string;
  workspaceName: string;
  platform: Platform;
  handle: string;
  status: AccountStatus;
  webhookSubscribed: boolean;
  tokenExpiresAt: Date | null;
  sent24h: number;
  failed24h: number;
  /** Why sends are failing, most common first. Empty when nothing failed. */
  topFailures: FailureReason[];
}

export interface FleetSummary {
  accounts: number;
  workspaces: number;
  broken: number;
  degraded: number;
  sent24h: number;
  failed24h: number;
}

/**
 * An open problem, grouped by kind across the whole fleet.
 *
 * The fleet page answers "what is broken and why" for one account at a time.
 * This answers the other question an admin has, which is whether forty accounts
 * are broken for forty reasons or for one.
 */
export interface IncidentGroup {
  kind: IncidentKind;
  severity: IncidentSeverity;
  accounts: number;
  occurrences: number;
  lastSeenAt: Date;
  /** Withheld when the viewer cannot read content. */
  sample: string | null;
}

export interface FleetOverview {
  summary: FleetSummary;
  rows: FleetAccountRow[];
  openIncidents: IncidentGroup[];
  /**
   * Email headroom, or null where it could not be read.
   *
   * Cloudflare does not publish Email Sending's daily quota and a new account
   * starts conservative, so an instance can be a busy day away from nobody
   * being able to sign in. This is the only place that failure is visible
   * before it happens.
   */
  emailPressure: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const SEVERITY_ORDER = { INFO: 0, WARNING: 1, ERROR: 2 } satisfies Record<IncidentSeverity, number>;

/**
 * A token inside this window is treated as a problem rather than a curiosity.
 * The refresh cron runs daily, so anything closer than a couple of days has
 * already failed to refresh at least once.
 */
const TOKEN_EXPIRY_WARNING_MS = 3 * DAY_MS;

function classify(params: {
  failed24h: number;
  sent24h: number;
  webhookSubscribed: boolean;
  tokenExpiresAt: Date | null;
  now: number;
}): AccountStatus {
  const { failed24h, sent24h, webhookSubscribed, tokenExpiresAt, now } = params;

  // Nothing can arrive without a webhook subscription, so this is broken even
  // when no send has failed. A quiet account and a deaf one look identical from
  // the ledger alone, which is why subscription state is checked directly.
  if (!webhookSubscribed) return "BROKEN";
  if (tokenExpiresAt && tokenExpiresAt.getTime() - now < 0) return "BROKEN";
  if (failed24h > 0 && sent24h === 0) return "BROKEN";

  if (tokenExpiresAt && tokenExpiresAt.getTime() - now < TOKEN_EXPIRY_WARNING_MS) {
    return "DEGRADED";
  }
  if (failed24h > 0) return "DEGRADED";
  return "HEALTHY";
}

/**
 * Meta errors quote the offending message back, so a raw reason can leak the
 * content a SUPPORT_READ viewer is not entitled to. The classification is what
 * makes the row actionable, and it survives.
 */
function redact(reason: string): string {
  const known = [
    "outside of allowed window",
    "invalid for a private reply",
    "requested user cannot be found",
    "rate limit",
    "access token",
    "permission",
  ];
  const match = known.find((k) => reason.toLowerCase().includes(k));
  return match ? `Send refused (${match})` : "Send refused";
}

const STATUS_ORDER = {
  BROKEN: 0,
  DEGRADED: 1,
  HEALTHY: 2,
} satisfies Record<AccountStatus, number>;

/**
 * Every connected account across every creator.
 *
 * `scope` is required rather than optional. A function that widens to all
 * workspaces should not be callable without proving the caller may see them,
 * and its tier decides whether failure reasons are readable, since a Meta error
 * can quote the comment that triggered it.
 */
export async function getFleetOverview(scope: PlatformScope): Promise<FleetOverview> {
  const now = Date.now();
  const since = new Date(now - DAY_MS);

  const accounts = await prisma.connectedAccount.findMany({
    select: {
      id: true,
      platform: true,
      username: true,
      webhookSubscribed: true,
      tokenExpiresAt: true,
      workspaceId: true,
      workspace: { select: { name: true } },
    },
    orderBy: { connectedAt: "desc" },
  });

  const [statusCounts, failures, incidents] = await Promise.all([
    prisma.responseRun.groupBy({
      by: ["connectedAccountId", "status"],
      where: { updatedAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.responseRun.findMany({
      where: {
        updatedAt: { gte: since },
        status: { in: ["FAILED", "SKIPPED_RATE_LIMIT", "SKIPPED_PLAN_LIMIT"] },
        errorMessage: { not: null },
      },
      select: { connectedAccountId: true, errorMessage: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: 2000,
    }),
    prisma.incident.findMany({
      where: { resolvedAt: null },
      select: {
        kind: true,
        severity: true,
        count: true,
        message: true,
        lastSeenAt: true,
        connectedAccountId: true,
      },
      orderBy: { lastSeenAt: "desc" },
      take: 2000,
    }),
  ]);

  const sent = new Map<string, number>();
  const failed = new Map<string, number>();
  for (const row of statusCounts) {
    const target = row.status === "SENT" ? sent : failed;
    if (row.status === "SENT" || row.status.startsWith("SKIPPED_") || row.status === "FAILED") {
      target.set(
        row.connectedAccountId,
        (target.get(row.connectedAccountId) ?? 0) + row._count._all
      );
    }
  }

  const reasons = new Map<string, Map<string, FailureReason>>();
  for (const failure of failures) {
    if (!failure.errorMessage) continue;
    // Meta error strings carry a trace id per occurrence, so the raw message is
    // unique every time and would never group. The prefix is the actual reason.
    const reason = failure.errorMessage.split(" [")[0].slice(0, 160);
    const perAccount = reasons.get(failure.connectedAccountId) ?? new Map();
    const existing = perAccount.get(reason);
    if (existing) {
      existing.count += 1;
    } else {
      perAccount.set(reason, { reason, count: 1, lastSeenAt: failure.updatedAt });
    }
    reasons.set(failure.connectedAccountId, perAccount);
  }

  const rows: FleetAccountRow[] = accounts.map((account) => {
    const sent24h = sent.get(account.id) ?? 0;
    const failed24h = failed.get(account.id) ?? 0;
    return {
      connectedAccountId: account.id,
      workspaceId: account.workspaceId,
      workspaceName: account.workspace.name,
      platform: account.platform,
      handle: account.username,
      status: classify({
        failed24h,
        sent24h,
        webhookSubscribed: account.webhookSubscribed,
        tokenExpiresAt: account.tokenExpiresAt,
        now,
      }),
      webhookSubscribed: account.webhookSubscribed,
      tokenExpiresAt: account.tokenExpiresAt,
      sent24h,
      failed24h,
      topFailures: [...(reasons.get(account.id)?.values() ?? [])]
        .sort((a, b) => b.count - a.count)
        .slice(0, 3)
        .map((failure) =>
          scope.canReadContent
            ? failure
            : { ...failure, reason: redact(failure.reason), redacted: true }
        ),
    };
  });

  rows.sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.failed24h - a.failed24h
  );

  const grouped = new Map<IncidentKind, IncidentGroup & { seen: Set<string> }>();
  for (const incident of incidents) {
    const existing = grouped.get(incident.kind);
    if (existing) {
      existing.occurrences += incident.count;
      if (incident.connectedAccountId) existing.seen.add(incident.connectedAccountId);
      if (incident.lastSeenAt > existing.lastSeenAt) existing.lastSeenAt = incident.lastSeenAt;
      if (SEVERITY_ORDER[incident.severity] > SEVERITY_ORDER[existing.severity]) {
        existing.severity = incident.severity;
      }
      continue;
    }
    grouped.set(incident.kind, {
      kind: incident.kind,
      severity: incident.severity,
      accounts: 0,
      occurrences: incident.count,
      lastSeenAt: incident.lastSeenAt,
      sample: scope.canReadContent ? incident.message : null,
      seen: new Set(incident.connectedAccountId ? [incident.connectedAccountId] : []),
    });
  }

  const openIncidents: IncidentGroup[] = [...grouped.values()]
    .map(({ seen, ...group }) => ({ ...group, accounts: seen.size }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
        b.accounts - a.accounts
    );

  const email = await readSendingLimits();

  return {
    emailPressure: email?.pressure ?? null,
    openIncidents,
    summary: {
      accounts: rows.length,
      workspaces: new Set(rows.map((r) => r.workspaceId)).size,
      broken: rows.filter((r) => r.status === "BROKEN").length,
      degraded: rows.filter((r) => r.status === "DEGRADED").length,
      sent24h: rows.reduce((n, r) => n + r.sent24h, 0),
      failed24h: rows.reduce((n, r) => n + r.failed24h, 0),
    },
    rows,
  };
}
