import { prisma } from "@/lib/db/client";
import type { Prisma } from "@/app/generated/prisma/client";
import { decryptToken, encryptToken } from "@/lib/meta/oauth";
import { adapterFor } from "@/lib/platforms/registry";
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
export const TOKEN_REFRESH_CRON = "0 5 * * *";

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

export async function refreshTokens() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const usageReset = await prisma.workspace.updateMany({
    where: { usagePeriodStart: { lt: monthStart } },
    data: {
      usagePeriodStart: monthStart,
      dmsSentThisPeriod: 0,
    },
  });

  // Every account with an expiry, on any platform. Whether it can be refreshed
  // and how soon is the adapter's answer, not this job's: Facebook Page tokens
  // never expire and carry no expiry to select on, Instagram refreshes by
  // presenting the token itself, and YouTube and TikTok need a stored refresh
  // token that only they know how to spend.
  const candidates = await prisma.connectedAccount.findMany({
    where: { accessToken: { not: "" }, tokenExpiresAt: { not: null } },
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

  const accountsToRefresh = candidates.filter((account) => {
    const lifetime = adapterFor(account.platform).tokens;
    if (lifetime.kind === "permanent") return false;
    const expiresAt = account.tokenExpiresAt;
    return expiresAt !== null && expiresAt.getTime() - now.getTime() <= lifetime.refreshWithinMs;
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
    workspacesReset: usageReset.count,
    results,
  };
}
