import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { getUserInfo } from "@/lib/meta/client";
import {
  backfillFollowerHistory,
  recordFollowerSnapshot,
} from "@/lib/reports/follower-history";

/**
 * Records one follower total per connected account per day.
 *
 * Instagram retains only ~30 days of account insights, so this job is the only
 * source of longer-range follower history. Missing a run loses that day
 * permanently — there is no way to backfill beyond the insights window.
 */
export async function snapshotFollowers() {
  const accounts = await prisma.connectedAccount.findMany({
    where: {
      // getUserInfo reads graph.instagram.com/me, so a Page row would be sent
      // an Instagram URL with a Page token.
      platform: "INSTAGRAM",
      accessToken: { not: "" },
    },
    select: {
      id: true,
      workspaceId: true,
      username: true,
      instagramId: true,
      accessToken: true,
    },
  });

  let recorded = 0;
  let backfilled = 0;
  const failures: Array<{ username: string; reason: string }> = [];

  for (const account of accounts) {
    try {
      const token = decryptToken(account.accessToken);
      const info = await getUserInfo(token);

      if (typeof info.followers_count !== "number") {
        failures.push({
          username: account.username,
          reason: "followers_count not returned",
        });
        continue;
      }

      await recordFollowerSnapshot(account.id, info.followers_count);
      recorded += 1;

      // First time we see this account, try to recover the last 30 days.
      const existing = await prisma.followerSnapshot.count({
        where: { connectedAccountId: account.id },
      });
      if (existing <= 1) {
        backfilled += await backfillFollowerHistory(
          account.id,
          token,
          account.instagramId,
          info.followers_count
        );
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Unknown error";
      failures.push({ username: account.username, reason });
      await prisma.operationalEvent
        .create({
          data: {
            source: "SYSTEM",
            level: "WARNING",
            workspaceId: account.workspaceId,
            message: "Follower snapshot failed",
            payload: { username: account.username, reason },
          },
        })
        .catch(() => {});
    }
  }

  return {
    accounts: accounts.length,
    recorded,
    backfilled,
    failures,
  };
}
