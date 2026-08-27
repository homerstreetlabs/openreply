/**
 * The sweep for platforms with no comment webhook.
 *
 * On Instagram and Facebook the reconciler is a safety net for comments Meta
 * never pushed. Here it is the only path, so a pass that does not run means the
 * comment is never seen. That difference is why this budgets quota before
 * looking rather than after failing.
 *
 * YouTube's ceiling is the binding constraint. Ten thousand units a day belong
 * to the Google Cloud project rather than to a creator, a poll costs one and a
 * reply costs fifty, and sharding across projects to get more is forbidden by
 * the Developer Policies. So the whole product can post roughly two hundred
 * automated replies a day before a compliance audit, and the fair share inside
 * the pool is what stops one channel spending it all.
 */

import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { adapterFor, pollOnlyPlatforms } from "@/lib/platforms/registry";
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import { COMMENT_JOB_NAME, enqueue } from "@/lib/queue/client";
import { discoveryBuckets, planSweep } from "@/lib/runtime/discovery";
import { pressure, reserve } from "@/lib/runtime/quota";
import type { Platform } from "@/app/generated/prisma/client";

/** Cap on how many comments one pass may enqueue, so a viral video drains gradually. */
const MAX_PER_SWEEP = 30;

/** Matches the reconciler's window. Older comments are outside every reply window. */
const LOOKBACK_HOURS = 72;

export interface PollSweepStat {
  platform: Platform;
  handle: string;
  swept: boolean;
  enqueued: number;
  skippedReason: string | null;
}

/**
 * One pass over every account whose platform can only be polled.
 *
 * Accounts are visited oldest-swept first, so a refusal partway through delays
 * the same accounts rather than always starving the tail.
 */
export async function sweepPollOnlyAccounts(): Promise<PollSweepStat[]> {
  const accounts = await prisma.connectedAccount.findMany({
    where: { platform: { in: pollOnlyPlatforms() } },
    orderBy: { updatedAt: "asc" },
    select: {
      id: true,
      platform: true,
      instagramId: true,
      username: true,
      accessToken: true,
      providerAppId: true,
      workspaceId: true,
    },
  });

  const stats: PollSweepStat[] = [];

  for (const account of accounts) {
    const adapter = adapterFor(account.platform);
    if (adapter.discovery.kind !== "poll") continue;

    const appId = account.providerAppId ?? "default";
    const buckets = discoveryBuckets(adapter, account.instagramId, appId);
    const plan = planSweep(adapter, await pressure(buckets));

    const reservation = await reserve(buckets, { units: plan.cost });
    if (!reservation.ok) {
      stats.push({
        platform: account.platform,
        handle: account.username,
        swept: false,
        enqueued: 0,
        // A primary sweep never stops, so this is the pool being genuinely
        // spent for the day rather than a pacing decision.
        skippedReason:
          reservation.refusal.retryAfterMs === null
            ? "quota exhausted, waiting will not help"
            : `quota exhausted, retry in ${reservation.refusal.retryAfterMs}ms`,
      });
      continue;
    }

    try {
      const enqueued = await sweepAccount(account.platform, account);
      await reservation.lease.settle("commit");
      stats.push({
        platform: account.platform,
        handle: account.username,
        swept: true,
        enqueued,
        skippedReason: null,
      });
    } catch (error) {
      // The units were spent whether or not we got usable comments back, so a
      // failure after the call commits rather than refunds. Refunding here would
      // let a persistently failing account poll the pool dry.
      await reservation.lease.settle("commit");
      stats.push({
        platform: account.platform,
        handle: account.username,
        swept: false,
        enqueued: 0,
        skippedReason: error instanceof Error ? error.message : "unknown sweep failure",
      });
    }
  }

  await recordSweep(stats);
  return stats;
}

async function sweepAccount(
  platform: Platform,
  account: { id: string; instagramId: string; accessToken: string }
): Promise<number> {
  const token = decryptToken(account.accessToken);
  // No postIds: a poll-only platform prices a channel-wide look cheaper than
  // one call per post, and narrowing here would spend more quota to see less.
  const comments = await adapterFor(platform).listRecentComments(
    token,
    account.instagramId,
    { postIds: [], sinceMs: Date.now() - LOOKBACK_HOURS * 3_600_000 }
  );
  if (comments.length === 0) return 0;

  const campaigns = await prisma.campaign.findMany({
    where: { isActive: true, connectedAccountId: account.id },
    select: {
      id: true,
      postId: true,
      matchAnyPost: true,
      matchAnyWord: true,
      keywords: true,
      wholeWordMatch: true,
    },
  });
  if (campaigns.length === 0) return 0;

  const seen = await prisma.seenTrigger.findMany({
    where: { externalId: { in: comments.map((c) => c.id) } },
    select: { externalId: true },
  });
  const seenIds = new Set(seen.map((s) => s.externalId));

  let enqueued = 0;

  for (const comment of comments) {
    if (enqueued >= MAX_PER_SWEEP) break;
    if (seenIds.has(comment.id)) continue;

    const matches = campaigns.some((campaign) => {
      const targeted =
        campaign.matchAnyPost || campaign.postId === comment.postId;
      if (!targeted) return false;
      return campaign.matchAnyWord
        ? true
        : matchKeywords(comment.text, campaign.keywords, campaign.wholeWordMatch).matched;
    });
    if (!matches) continue;

    await enqueue(
      COMMENT_JOB_NAME,
      {
        platform,
        instagramAccountId: account.instagramId,
        commentId: comment.id,
        commentText: comment.text,
        commenterId: comment.authorId,
        commenterName: comment.authorName ?? undefined,
        mediaId: comment.postId,
        source: "POLLING",
      },
      `${platform.toLowerCase()}_comment_${account.instagramId}_${comment.id}`
    );

    // Recorded before the send so a redelivered sweep does not re-enqueue. The
    // send path is idempotent regardless, but a poll that costs quota should not
    // spend it discovering the same comment twice.
    await prisma.seenTrigger
      .create({
        data: {
          connectedAccountId: account.id,
          externalId: comment.id,
          source: "POLLING",
        },
      })
      .catch(() => {});

    enqueued += 1;
  }

  return enqueued;
}

async function recordSweep(stats: PollSweepStat[]): Promise<void> {
  const acted = stats.filter((s) => s.enqueued > 0 || s.skippedReason);
  if (acted.length === 0) return;

  await prisma.operationalEvent
    .create({
      data: {
        source: "SYSTEM",
        level: acted.some((s) => s.skippedReason) ? "WARNING" : "INFO",
        message: `Poll sweep: ${acted.length} accounts, ${acted.reduce((n, s) => n + s.enqueued, 0)} enqueued`,
        payload: { stats: acted.map((s) => ({ ...s })) },
      },
    })
    .catch(() => {});
}
