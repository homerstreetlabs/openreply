import { prisma } from "@/lib/db/client";
import type { Prisma } from "@/app/generated/prisma/client";
import { decryptToken, encryptToken } from "@/lib/meta/oauth";
import { ADAPTERS, adapterFor } from "@/lib/platforms/registry";
import type { Platform } from "@/lib/platforms/types";
import { classifyFailure, raiseIncident, resolveIncident } from "@/lib/ops/incidents";

/**
 * Which cron tick repairs tokens.
 *
 * Exported because it is half of an invariant the other half of which lives in
 * the adapters: a tick that fires less often than the narrowest
 * `refreshWithinMs` can never catch a token inside its window. YouTube wants
 * ten minutes' notice, so a daily tick misses it by two orders of magnitude.
 * `__tests__/token-refresh-cadence.test.ts` holds the two together.
 */
export const TOKEN_REFRESH_CRON = "*/5 * * * *";

/**
 * How often a cron expression fires, for the shapes this Worker uses: a
 * step across the minute field, or a fixed daily time.
 */
export function cronIntervalMs(expression: string): number {
  const [minute, hour] = expression.split(" ");
  const step = /^\*\/(\d+)$/.exec(minute);
  if (step && hour === "*") return Number(step[1]) * 60_000;
  return 24 * 3_600_000;
}

/**
 * Roll each workspace's usage period over when the month turns.
 *
 * Split out of the token refresh, which now runs every five minutes. The reset
 * wants a daily tick and nothing more, and running it on the fast one would be
 * a write that matches no rows 288 times a day.
 */
export async function resetMonthlyUsage(): Promise<{ workspacesReset: number }> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const reset = await prisma.workspace.updateMany({
    where: { usagePeriodStart: { lt: monthStart } },
    data: { usagePeriodStart: monthStart, dmsSentThisPeriod: 0 },
  });

  return { workspacesReset: reset.count };
}

/**
 * Which accounts are inside their platform's refresh window right now.
 *
 * Derived from the registry rather than listed, so a fifth platform is selected
 * without editing this, and built as a query rather than a filter because at a
 * five-minute cadence reading every account into the Worker to discard most of
 * them is 288 full scans a day.
 */
function dueForRefresh(now: Date): Prisma.ConnectedAccountWhereInput {
  // SAFETY: ADAPTERS is `satisfies { [P in Platform]: PlatformAdapter }`, so its
  // keys are exactly the Platform union and the compiler enforces that.
  const windows = (Object.keys(ADAPTERS) as Platform[]).flatMap((platform) => {
    const lifetime = ADAPTERS[platform].tokens;
    // A permanent token carries no expiry to select on and nothing to spend.
    if (lifetime.kind === "permanent") return [];
    return [
      {
        platform,
        tokenExpiresAt: { lte: new Date(now.getTime() + lifetime.refreshWithinMs) },
      },
    ];
  });

  return { accessToken: { not: "" }, tokenExpiresAt: { not: null }, OR: windows };
}

export async function refreshTokens() {
  const now = new Date();

  const accountsToRefresh = await prisma.connectedAccount.findMany({
    where: dueForRefresh(now),
    select: {
      id: true,
      platform: true,
      workspaceId: true,
      username: true,
      accessToken: true,
      refreshToken: true,
      tokenExpiresAt: true,
    },
  });

  const results: Array<{
    instagramAccountId: string;
    username: string;
    status: "refreshed" | "failed";
    error?: string;
  }> = [];

  for (const account of accountsToRefresh) {
    const lifetime = adapterFor(account.platform).tokens;
    if (lifetime.kind === "permanent") continue;

    try {
      const currentToken = decryptToken(account.accessToken);
      const currentRefresh = account.refreshToken
        ? decryptToken(account.refreshToken)
        : null;
      const refreshed = await lifetime.refresh(currentToken, currentRefresh);

      const data: Prisma.ConnectedAccountUpdateInput = {
        accessToken: encryptToken(refreshed.accessToken),
        tokenExpiresAt: new Date(Date.now() + refreshed.expiresInSeconds * 1000),
      };
      // Some platforms rotate the refresh token too. Keeping the old one after
      // a rotation is how an account silently stops being refreshable.
      if (refreshed.refreshToken) {
        data.refreshToken = encryptToken(refreshed.refreshToken);
      }

      await prisma.connectedAccount.update({ where: { id: account.id }, data });
      await resolveIncident(account.id, "TOKEN_EXPIRED");

      results.push({
        instagramAccountId: account.id,
        username: account.username,
        status: "refreshed",
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      // A refresh token that has itself expired cannot be recovered by retrying;
      // the creator has to authorize again. Raising it is what puts that on the
      // fleet view instead of leaving a cron to fail forever in the logs.
      await raiseIncident({
        connectedAccountId: account.id,
        workspaceId: account.workspaceId,
        kind: classifyFailure(err),
        message: `Token refresh failed for @${account.username}: ${errorMessage}`,
      });
      await prisma.operationalEvent.create({
        data: {
          workspaceId: account.workspaceId,
          source: "TOKEN_REFRESH",
          level: "ERROR",
          message: `Token refresh failed for @${account.username}: ${errorMessage}`,
          payload: {
            instagramAccountId: account.id,
            username: account.username,
          },
        },
      });

      results.push({
        instagramAccountId: account.id,
        username: account.username,
        status: "failed",
        error: errorMessage,
      });
    }
  }

  return {
    totalProcessed: accountsToRefresh.length,
    results,
  };
}
