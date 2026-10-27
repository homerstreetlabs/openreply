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
import type { DmStatus, IncidentKind, IncidentSeverity, Platform } from "@/app/generated/prisma/client";
import type { PlatformScope } from "@/lib/tenancy/platform-scope";
import { adapterFor } from "@/lib/platforms/registry";

export type AccountStatus = "HEALTHY" | "DEGRADED" | "BROKEN";

export interface AccountHealth {
  status: AccountStatus;
  /** What is wrong with the account itself, apart from failed sends. */
  note: string | null;
}

export interface FailureReason {
  reason: string;
  count: number;
  lastSeenAt: Date;
  /** True when the reason was withheld because the viewer cannot read content. */
  redacted?: boolean;
}

export interface FleetAccountRow extends AccountHealth {
  connectedAccountId: string;
  workspaceId: string;
  workspaceName: string;
  platform: Platform;
  handle: string;
  webhookSubscribed: boolean;
  tokenExpiresAt: Date | null;
  sent: number;
  failed: number;
  /** Why sends are failing, most common first. Empty when nothing failed. */
  topFailures: FailureReason[];
}

export interface FleetSummary {
  accounts: number;
  workspaces: number;
  broken: number;
  degraded: number;
  sent: number;
  failed: number;
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
  /** The span the sent and failed counts cover. Health status always judges the last day. */
  window: ActivityWindow;
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

export const ACTIVITY_WINDOWS = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
} as const satisfies Record<string, number>;

export type ActivityWindow = keyof typeof ACTIVITY_WINDOWS;

function isActivityWindow(value: string): value is ActivityWindow {
  return Object.hasOwn(ACTIVITY_WINDOWS, value);
}

export function parseActivityWindow(value: string | null): ActivityWindow {
  return value !== null && isActivityWindow(value) ? value : "24h";
}

const SEVERITY_ORDER = { INFO: 0, WARNING: 1, ERROR: 2 } satisfies Record<IncidentSeverity, number>;

/**
 * How long the refresh cron gets past the start of a token's refresh window
 * before the account counts as degraded. It runs every five minutes, so this
 * is three missed chances.
 */
const REFRESH_GRACE_MS = 15 * 60 * 1000;

/**
 * Judged against what the account's platform actually needs. Only platforms
 * that subscribe per account can be deaf for want of a subscription, and a
 * token is a problem only once the refresh cron should already have renewed
 * it, which is a day for TikTok and minutes for YouTube.
 */
export function classify(params: {
  platform: Platform;
  failed24h: number;
  sent24h: number;
  webhookSubscribed: boolean;
  tokenExpiresAt: Date | null;
  now: number;
}): AccountHealth {
  const { platform, failed24h, sent24h, webhookSubscribed, tokenExpiresAt, now } = params;
  const adapter = adapterFor(platform);
  const remainingMs = tokenExpiresAt ? tokenExpiresAt.getTime() - now : null;

  // A quiet account and a deaf one look identical from the ledger alone, which
  // is why subscription state is checked directly.
  if (adapter.subscribeToEvents && !webhookSubscribed) {
    return { status: "BROKEN", note: "not receiving webhooks" };
  }
  if (remainingMs !== null && remainingMs < 0) return { status: "BROKEN", note: "token expired" };
  if (failed24h > 0 && sent24h === 0) return { status: "BROKEN", note: null };

  if (
    remainingMs !== null &&
    adapter.tokens.kind === "refreshable" &&
    remainingMs < adapter.tokens.refreshWithinMs - REFRESH_GRACE_MS
  ) {
    return { status: "DEGRADED", note: `token refresh overdue, expires in ${formatRemaining(remainingMs)}` };
  }
  if (failed24h > 0) return { status: "DEGRADED", note: null };
  return { status: "HEALTHY", note: null };
}

function formatRemaining(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours >= 48) return `${Math.round(hours / 24)}d`;
  if (hours >= 1) return `${Math.round(hours)}h`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
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

interface RunStatusCount {
  connectedAccountId: string;
  status: DmStatus;
  _count: { _all: number };
}

function countOutcomes(statusCounts: RunStatusCount[]) {
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
  return { sent, failed };
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
export async function getFleetOverview(
  scope: PlatformScope,
  window: ActivityWindow
): Promise<FleetOverview> {
  const now = Date.now();
  const since = new Date(now - ACTIVITY_WINDOWS[window]);
  const countRunsSince = (from: Date) =>
    prisma.responseRun.groupBy({
      by: ["connectedAccountId", "status"],
      where: { updatedAt: { gte: from } },
      _count: { _all: true },
    });

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

  const [windowCounts, dayCounts, failures, incidents] = await Promise.all([
    countRunsSince(since),
    window === "24h" ? null : countRunsSince(new Date(now - DAY_MS)),
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

  const activity = countOutcomes(windowCounts);
  // An old failure must not break an account today, so health ignores the window.
  const lastDay = dayCounts ? countOutcomes(dayCounts) : activity;

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
    return {
      connectedAccountId: account.id,
      workspaceId: account.workspaceId,
      workspaceName: account.workspace.name,
      platform: account.platform,
      handle: account.username,
      ...classify({
        platform: account.platform,
        failed24h: lastDay.failed.get(account.id) ?? 0,
        sent24h: lastDay.sent.get(account.id) ?? 0,
        webhookSubscribed: account.webhookSubscribed,
        tokenExpiresAt: account.tokenExpiresAt,
        now,
      }),
      webhookSubscribed: account.webhookSubscribed,
      tokenExpiresAt: account.tokenExpiresAt,
      sent: activity.sent.get(account.id) ?? 0,
      failed: activity.failed.get(account.id) ?? 0,
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
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.failed - a.failed
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
    window,
    emailPressure: email?.pressure ?? null,
    openIncidents,
    summary: {
      accounts: rows.length,
      workspaces: new Set(rows.map((r) => r.workspaceId)).size,
      broken: rows.filter((r) => r.status === "BROKEN").length,
      degraded: rows.filter((r) => r.status === "DEGRADED").length,
      sent: rows.reduce((n, r) => n + r.sent, 0),
      failed: rows.reduce((n, r) => n + r.failed, 0),
    },
    rows,
  };
}
