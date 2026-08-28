import { notFound, redirect } from "next/navigation";
import { getSessionScope } from "@/lib/session";
import { accountDirectory, accountWithToken } from "@/lib/accounts/directory";
import { adapterFor } from "@/lib/platforms/registry";
import PlatformPills from "@/components/platform-pills";
import StatCard from "@/components/stat-card";
import CombinedAudience from "@/components/combined-audience";
import { combinedAudience } from "@/lib/accounts/audience";
import type { AccountReport } from "@/lib/platforms/types";

/** Instagram's per-post insight fan-out is one request per post, so this is a budget. */
const POST_LIMIT = 50;

export const dynamic = "force-dynamic";

function formatNumber(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export default async function OverviewPage({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  const { accountId } = await params;
  const scope = await getSessionScope();
  if (!scope) redirect("/login");

  const [directory, resolved] = await Promise.all([
    accountDirectory(scope.workspaceId),
    accountWithToken(scope.workspaceId, accountId),
  ]);
  if (!resolved) notFound();

  const { account, accessToken } = resolved;
  const maybeInsights = adapterFor(account.platform).insights;
  if (!maybeInsights) notFound();
  // Bound after the guard so the narrowing survives into the closure below.
  const insights = maybeInsights;

  /**
   * A platform refusing must not blank the page. The reason becomes a notice,
   * which is the channel a missing permission already uses, so the page has one
   * way to explain an absence rather than two.
   */
  async function reportOrNotice(): Promise<AccountReport> {
    try {
      return await insights.buildReport(accessToken, account.externalId, {
        limit: POST_LIMIT,
      });
    } catch (failure) {
      const message =
        failure instanceof Error
          ? failure.message
          : `${account.label} did not return analytics.`;
      return { tiles: [], columns: [], rows: [], notices: [{ kind: "permission", message }] };
    }
  }

  // The audience roll-up spans every account, so it must not wait on this
  // account's post-by-post report, and neither may fail the other.
  const [report, audience] = await Promise.all([
    reportOrNotice(),
    combinedAudience(scope.workspaceId),
  ]);

  const tiles = [...report.tiles].sort((a, b) => a.rank - b.rank);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Overview</h1>
        <p className="mt-1 text-sm text-muted">
          {account.label} · {report.rows.length} recent{" "}
          {report.rows.length === 1 ? "post" : "posts"}
        </p>
      </div>

      <PlatformPills
        groups={directory.platforms.filter((group) =>
          group.accounts.some((a) => adapterFor(a.platform).insights !== null)
        )}
        activeId={account.id}
        hrefFor={(a) => `/overview/${a.id}`}
      />

      {report.notices.map((notice) => (
        <div key={notice.message} className="panel rounded border border-border p-4">
          <p className="text-sm text-foreground">{notice.message}</p>
        </div>
      ))}

      <CombinedAudience audience={audience} />

      {tiles.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 sm:gap-4">
          {tiles.map((tile) => (
            <StatCard
              key={tile.metric}
              label={tile.label}
              value={formatNumber(tile.value)}
            />
          ))}
        </div>
      )}

      <div className="panel rounded p-4 sm:p-6">
        <h2 className="mb-4 text-sm font-semibold text-foreground">Posts</h2>
        {report.rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">No posts found</p>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-zinc-500">
                  <th className="py-2 pr-4 font-medium">Post</th>
                  {report.columns.map((column) => (
                    <th key={column.metric} className="px-3 py-2 text-right font-medium">
                      {column.label}
                    </th>
                  ))}
                  <th className="py-2 pl-3 text-right font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={row.post.id} className="border-b border-border last:border-0">
                    <td className="max-w-xs py-3 pr-4">
                      {row.post.permalink ? (
                        <a
                          href={row.post.permalink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block truncate text-foreground hover:text-accent"
                        >
                          {row.post.caption || `${row.post.mediaType} post`}
                        </a>
                      ) : (
                        <span className="block truncate text-foreground">
                          {row.post.caption || `${row.post.mediaType} post`}
                        </span>
                      )}
                    </td>
                    {report.columns.map((column) => (
                      <td key={column.metric} className="px-3 py-3 text-right text-muted">
                        {formatNumber(row.values[column.metric] ?? null)}
                      </td>
                    ))}
                    <td className="py-3 pl-3 text-right text-zinc-500">
                      {formatDate(row.post.timestamp)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
