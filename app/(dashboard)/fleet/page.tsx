"use client";

import { useEffect, useState } from "react";

/**
 * Every connected account across every workspace, worst first.
 *
 * The question this answers is "what is broken and why", so the failure reason
 * travels with the row. An admin who has to open a second page to learn why an
 * account is red will not do it for the fortieth account.
 */

type AccountStatus = "HEALTHY" | "DEGRADED" | "BROKEN";

interface FailureReason {
  reason: string;
  count: number;
  lastSeenAt: string;
  redacted?: boolean;
}

interface FleetAccountRow {
  connectedAccountId: string;
  workspaceId: string;
  workspaceName: string;
  platform: string;
  handle: string;
  status: AccountStatus;
  webhookSubscribed: boolean;
  tokenExpiresAt: string | null;
  sent24h: number;
  failed24h: number;
  topFailures: FailureReason[];
}

interface IncidentGroup {
  kind: string;
  severity: "INFO" | "WARNING" | "ERROR";
  accounts: number;
  occurrences: number;
  lastSeenAt: string;
  sample: string | null;
}

interface FleetOverview {
  emailPressure: number | null;
  openIncidents: IncidentGroup[];
  summary: {
    accounts: number;
    workspaces: number;
    broken: number;
    degraded: number;
    sent24h: number;
    failed24h: number;
  };
  rows: FleetAccountRow[];
}

const STATUS_STYLES = {
  HEALTHY: "bg-emerald-500/10 text-emerald-600",
  DEGRADED: "bg-amber-500/10 text-amber-600",
  BROKEN: "bg-red-500/10 text-red-600",
} satisfies Record<AccountStatus, string>;

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="panel rounded p-4">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone ?? "text-foreground"}`}>{value}</p>
    </div>
  );
}

function tokenNote(row: FleetAccountRow): string | null {
  if (!row.tokenExpiresAt) return null;
  const days = Math.round((Date.parse(row.tokenExpiresAt) - Date.now()) / 86_400_000);
  if (days < 0) return "token expired";
  if (days <= 7) return `token expires in ${days}d`;
  return null;
}

export default function FleetPage() {
  const [data, setData] = useState<FleetOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<AccountStatus | "ALL">("ALL");

  useEffect(() => {
    let active = true;

    async function load() {
      const response = await fetch("/api/admin/fleet");
      const payload = await response.json();
      if (!active) return;
      if (payload.success) setData(payload.data);
      else setError(payload.error ?? "Could not load the fleet.");
      setLoading(false);
    }

    void load();
    return () => {
      active = false;
    };
  }, []);

  if (loading) return <div className="panel rounded p-8 h-64" />;

  if (error) {
    return (
      <div className="panel rounded p-6">
        <p className="text-sm text-muted">{error}</p>
      </div>
    );
  }

  if (!data) return null;

  const rows =
    statusFilter === "ALL"
      ? data.rows
      : data.rows.filter((r) => r.status === statusFilter);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Fleet</h1>
        <p className="mt-1 text-sm text-muted">
          Every connected account across all creators, worst first.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Accounts" value={data.summary.accounts} />
        <Stat label="Creators" value={data.summary.workspaces} />
        <Stat label="Broken" value={data.summary.broken} tone="text-red-600" />
        <Stat label="Degraded" value={data.summary.degraded} tone="text-amber-600" />
        <Stat label="Sent 24h" value={data.summary.sent24h} />
        <Stat label="Failed 24h" value={data.summary.failed24h} tone="text-red-600" />
      </div>

      {data.openIncidents.length > 0 && (
        <section className="panel rounded p-4 sm:p-6">
          {data.emailPressure !== null && data.emailPressure > 0.8 && (
            <p className="mb-4 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
              Email sending is {Math.round(data.emailPressure * 100)}% of today&apos;s
              quota. Cloudflare does not publish that ceiling and a new account starts
              low. Past it, magic links stop arriving and nobody can sign in.
            </p>
          )}
          <h2 className="text-base font-semibold text-foreground">Open problems</h2>
          <p className="mt-1 text-xs text-muted">
            Grouped by cause, so forty broken accounts with one cause read as one
            problem.
          </p>
          <ul className="mt-4 space-y-3">
            {data.openIncidents.map((incident) => (
              <li key={incident.kind} className="flex items-baseline justify-between gap-4">
                <div className="min-w-0">
                  <span
                    className={`text-sm font-medium ${
                      incident.severity === "ERROR" ? "text-red-600" : "text-amber-600"
                    }`}
                  >
                    {incident.kind.toLowerCase().replace(/_/g, " ")}
                  </span>
                  {incident.sample && (
                    <p className="truncate text-xs text-muted">{incident.sample}</p>
                  )}
                </div>
                <span className="shrink-0 text-xs tabular-nums text-muted">
                  {incident.accounts} {incident.accounts === 1 ? "account" : "accounts"},{" "}
                  {incident.occurrences} failures
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex gap-2">
        {(["ALL", "BROKEN", "DEGRADED", "HEALTHY"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`rounded border px-3 py-1.5 text-xs font-medium transition ${
              statusFilter === s
                ? "border-accent text-accent"
                : "border-border text-muted hover:text-foreground"
            }`}
          >
            {s === "ALL" ? "All" : s.charAt(0) + s.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      <section className="panel rounded">
        {rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted">
            Nothing here. That is the good outcome.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">Account</th>
                  <th className="px-4 py-3 font-medium">Creator</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Sent 24h</th>
                  <th className="px-4 py-3 font-medium text-right">Failed</th>
                  <th className="px-4 py-3 font-medium">Why</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const note = tokenNote(row);
                  return (
                    <tr key={row.connectedAccountId} className="border-b border-border last:border-0">
                      <td className="px-4 py-3">
                        <span className="font-medium text-foreground">@{row.handle}</span>
                        <span className="ml-2 text-xs text-muted">{row.platform}</span>
                      </td>
                      <td className="px-4 py-3">
                        <a
                          href={`/campaigns?workspaceId=${row.workspaceId}`}
                          className="text-muted underline decoration-dotted hover:text-foreground"
                          title={`Open ${row.workspaceName}'s campaigns. Every action there is recorded against your grant.`}
                        >
                          {row.workspaceName}
                        </a>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[row.status]}`}
                        >
                          {row.status.toLowerCase()}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-foreground">
                        {row.sent24h}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-red-600">
                        {row.failed24h || ""}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted">
                        {row.topFailures.length === 0 && !note && !row.webhookSubscribed && (
                          <span>not receiving webhooks</span>
                        )}
                        {note && <div>{note}</div>}
                        {row.topFailures.slice(0, 2).map((f) => (
                          <div key={f.reason}>
                            {f.redacted ? "reason withheld" : f.reason}
                            {f.count > 1 && ` (${f.count})`}
                          </div>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
