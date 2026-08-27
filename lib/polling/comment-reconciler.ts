/**
 * Comment reconciliation (polling safety net).
 *
 * Instagram webhooks are best-effort and never fire for a large class of
 * comments (collapsed "load more" comments, non-follower / low-signal accounts,
 * anything Instagram filters). Those comments are otherwise invisible: never
 * replied to, never DM'd.
 *
 * This sweep is deliberately narrow. For each active campaign it looks only at
 * that campaign's post, only at recent comments, and acts on a comment ONLY when
 * both are true:
 *   1. the comment matches the campaign keyword, and
 *   2. the account owner has not already replied to it.
 * The reply check reads the comment's actual replies on Instagram, so a comment
 * you (or the tool) already answered is skipped — the poll never re-touches
 * handled comments. Each sweep is capped so it can never flood the comment API
 * (which Instagram rate-limits aggressively, error 368).
 *
 * It runs on an interval in the worker process because platform crons only
 * fire once a day. Matching and sending reuse the worker's processComment, so
 * rate limiting and logging behave exactly as for webhook-delivered comments.
 *
 * Known limitation, handled not fixed: comments removed by Instagram's Hidden
 * Words / spam filter may not be returned by the Graph API at all. Disable that
 * filter on the account to widen results.
 */

import { prisma } from "@/lib/db/client";
import { enqueue, COMMENT_JOB_NAME } from "@/lib/queue/client";
import { MetaApiError } from "@/lib/meta/client";
import { adapterFor, webhookPlatforms } from "@/lib/platforms/registry";
import type { DiscoveredComment, Platform } from "@/lib/platforms/types";
import { decryptToken } from "@/lib/meta/oauth";
import { matchKeywords } from "@/lib/utils/keyword-matcher";

// Only consider comments from the last few days — older ones are outside
// Instagram's private-reply window anyway, so a DM to them would just fail.
const LOOKBACK_HOURS = Number(process.env.COMMENT_POLL_LOOKBACK_HOURS ?? 72);
// Hard cap on how many new comments a single campaign can enqueue per sweep, so
// a viral post drains gradually instead of bursting into the comment API.
const MAX_NEW_PER_SWEEP = Number(process.env.COMMENT_POLL_MAX_PER_SWEEP ?? 30);
// For "any post" campaigns, how many recent posts to scan.
const RECENT_MEDIA_LIMIT = 10;

interface SweepStat {
  campaign: string;
  keywords: string;
  matched: number;
  alreadyReplied: number;
  enqueued: number;
  errors: string[];
}

function errMessage(error: unknown): string {
  if (error instanceof MetaApiError) return `Meta ${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

/** One reconciliation pass across every active campaign. */
export async function reconcileComments(): Promise<void> {
  // Every platform a webhook delivers for, because the safety net is needed
  // wherever deliveries can be dropped. Meta unsubscribes an app after an hour
  // of failures, so Facebook needs this as much as Instagram does. Poll-only
  // platforms are swept by `sweepPollOnlyAccounts`, which prices each pass
  // against its own quota.
  const automations = await prisma.campaign.findMany({
    where: { isActive: true, connectedAccount: { platform: { in: webhookPlatforms() } } },
    select: {
      id: true,
      name: true,
      postId: true,
      matchAnyPost: true,
      matchAnyWord: true,
      keywords: true,
      wholeWordMatch: true,
      publicReplyEnabled: true,
      workspaceId: true,
      connectedAccount: {
        select: {
          id: true,
          platform: true,
          instagramId: true,
          username: true,
          accessToken: true,
        },
      },
    },
  });

  const sinceMs = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
  const tokenCache = new Map<string, string | null>();

  for (const automation of automations) {
    const stat = await sweepCampaign(automation, sinceMs, tokenCache).catch(
      (error): SweepStat => ({
        campaign: automation.name,
        keywords: automation.keywords.join(","),
        matched: 0,
        alreadyReplied: 0,
        enqueued: 0,
        errors: [errMessage(error)],
      })
    );
    await recordSweep(automation.workspaceId, stat);
  }
}

async function sweepCampaign(
  automation: {
    id: string;
    name: string;
    postId: string | null;
    matchAnyPost: boolean;
    matchAnyWord: boolean;
    keywords: string[];
    wholeWordMatch: boolean;
    publicReplyEnabled: boolean;
    connectedAccount: {
      id: string;
      platform: Platform;
      instagramId: string;
      username: string;
      accessToken: string;
    };
  },
  sinceMs: number,
  tokenCache: Map<string, string | null>
): Promise<SweepStat> {
  const account = automation.connectedAccount;
  const stat: SweepStat = {
    campaign: automation.name,
    keywords: automation.matchAnyWord
      ? "(any word)"
      : automation.keywords.join(","),
    matched: 0,
    alreadyReplied: 0,
    enqueued: 0,
    errors: [],
  };

  // Decrypt the account token once per sweep.
  let accessToken = tokenCache.get(account.id);
  if (accessToken === undefined) {
    try {
      accessToken = decryptToken(account.accessToken);
    } catch {
      accessToken = null;
    }
    tokenCache.set(account.id, accessToken);
  }
  if (!accessToken) {
    stat.errors.push("Failed to decrypt access token");
    return stat;
  }

  const adapter = adapterFor(account.platform);

  // Which posts this campaign covers: its own, or the recent feed if it matches
  // any post.
  const mediaIds: string[] = [];
  if (automation.postId) {
    mediaIds.push(automation.postId);
  } else if (automation.matchAnyPost) {
    try {
      const posts = await adapter.listPosts(
        accessToken,
        account.instagramId,
        RECENT_MEDIA_LIMIT
      );
      mediaIds.push(...posts.map((m) => m.id));
    } catch (error) {
      stat.errors.push(`Media list: ${errMessage(error)}`);
    }
  }
  if (mediaIds.length === 0) return stat;

  for (const mediaId of mediaIds) {
    let comments: DiscoveredComment[];
    try {
      comments = await adapter.listRecentComments(accessToken, account.instagramId, {
        postIds: [mediaId],
        sinceMs,
      });
    } catch (error) {
      stat.errors.push(`Comments ${mediaId}: ${errMessage(error)}`);
      continue;
    }

    // Keep only comments that (a) aren't the account's own, (b) match the
    // keyword, and (c) have no reply from the account owner yet.
    //
    // `ownerHasReplied: null` means the listing could not answer, which is not
    // the same as nobody having replied. The ResponseRun check below is the
    // fallback, so a platform that cannot report replies costs an extra query
    // rather than a duplicate response.
    const needsAction = comments.filter((c) => {
      if (c.authorId === account.instagramId) return false;

      const matched = automation.matchAnyWord
        ? true
        : matchKeywords(c.text, automation.keywords, automation.wholeWordMatch)
            .matched;
      if (!matched) return false;
      stat.matched += 1;

      if (c.ownerHasReplied === true) {
        stat.alreadyReplied += 1;
        return false;
      }
      return true;
    });
    if (needsAction.length === 0) continue;

    // Second guard against races: skip comments this campaign has already fully
    // handled. "Fully handled" depends on the campaign: if it posts a public
    // reply, the completion signal is publicReplySentAt (a DM alone is not
    // enough — the reply still has to land); otherwise a SENT DM is enough. This
    // is what lets a comment whose DM sent but whose public reply failed come
    // back and retry the reply.
    const handled = await prisma.responseRun.findMany({
      where: {
        campaignId: automation.id,
        triggerKey: { in: needsAction.map((c) => c.id) },
        ...(automation.publicReplyEnabled
          ? { publicReplySentAt: { not: null } }
          : { status: "SENT" }),
      },
      select: { triggerKey: true },
    });
    const handledSet = new Set(handled.map((h) => h.triggerKey));

    // Oldest first, so whoever commented earliest gets answered first, capped.
    const fresh = needsAction
      .filter((c) => !handledSet.has(c.id))
      .sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0))
      .slice(0, MAX_NEW_PER_SWEEP);

    for (const c of fresh) {
      // The key is carried for tracing, not enforced: Cloudflare Queues has no
      // dedup and delivers at least once. Dedup is the owner-reply and ResponseRun
      // guards above plus the worker's own idempotency, which is what makes
      // re-processing a comment safe.
      await enqueue(
        COMMENT_JOB_NAME,
        {
          platform: account.platform,
          instagramAccountId: account.instagramId,
          commentId: c.id,
          commentText: c.text,
          commenterId: c.authorId,
          commenterName: c.authorName ?? undefined,
          mediaId,
          source: "POLLING",
        },
        `comment_${account.instagramId}_${c.id}`
      );
      stat.enqueued += 1;
    }
  }

  return stat;
}

async function recordSweep(
  workspaceId: string,
  stat: SweepStat
): Promise<void> {
  // Only log when something happened or something went wrong.
  if (stat.enqueued === 0 && stat.errors.length === 0) return;

  await prisma.operationalEvent
    .create({
      data: {
        workspaceId,
        source: "SYSTEM",
        level: stat.errors.length > 0 ? "WARNING" : "INFO",
        message: `Comment sweep "${stat.campaign}" [${stat.keywords}]: ${stat.enqueued} enqueued, ${stat.matched} matched, ${stat.alreadyReplied} already replied`,
        payload: { ...stat },
      },
    })
    .catch(() => {});
}
