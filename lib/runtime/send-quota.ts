/**
 * What one response costs, and which budgets it draws from.
 *
 * The send path used to charge every platform Instagram's fixed 750 an hour,
 * and charged the public reply nothing at all. On YouTube that second gap is
 * the serious one: `comments.insert` costs 50 units against a pool of 10,000 a
 * day shared by every creator, so an unmetered reply path can exhaust the whole
 * product's budget while the scheduler still believes it has room to poll.
 *
 * The cost travels with the buckets because YouTube's two operations differ by
 * fifty times. A caller that had to supply the cost separately would eventually
 * supply the wrong one.
 */

import type { Platform } from "@/app/generated/prisma/client";
import type { BucketSpec, Capacity, Spend } from "@/lib/runtime/quota";

export type ResponseAction = "privateReply" | "publicReply";

export interface ResponseCost {
  readonly buckets: readonly BucketSpec[];
  readonly cost: Spend;
}

/** Meta's documented cap for private replies, per account, per rolling hour. */
const META_PRIVATE_REPLY_PER_HOUR = 750;

/**
 * Facebook's ceiling before any engagement has been measured.
 *
 * Meta's formula is 4800 calls a day times the Page's engaged users, so the
 * true number is unknown until a refresh runs. This is deliberately small: a
 * floor that under-grants costs delayed sends, and one that over-grants costs
 * an app-level restriction.
 */
const FACEBOOK_CAPACITY_FLOOR = 4_800;

/** A measured Page ceiling older than this is treated as unmeasured. */
const FACEBOOK_CAPACITY_STALE_MS = 24 * 3_600_000;

/**
 * How many automated replies one post may carry in a day.
 *
 * Neither number is documented. Both policies are qualitative, so these are
 * judgements about what reads as organic, and the cost of being wrong lands on
 * the creator's account rather than ours.
 *
 * YouTube's spam policy names "high-volume, repetitive… comments… to drive
 * traffic". TikTok's warning is sharper still: a flagged reply is hidden and the
 * `set_to_public` webhook that would tell us never arrives, so we would carry on
 * replying into a void.
 */
const REPLIES_PER_POST_PER_DAY = { YOUTUBE: 20, TIKTOK: 15 } as const;

/** Documented YouTube unit costs. The gap between them decides the scheduler. */
const YOUTUBE_UNITS = { publicReply: 50, privateReply: 0 } as const;

/** Per authorised account per endpoint, at TikTok's default tier. */
const TIKTOK_ACCOUNT_PER_MINUTE = 40;
/** App-wide across every Accounts API endpoint, at the default tier. */
const TIKTOK_APP_PER_MINUTE = 600;

export interface AccountBudget {
  readonly accountExternalId: string;
  /** The post being responded to, where a platform meters per post. */
  readonly postId?: string | null;
  readonly providerAppId: string;
  /** Measured ceiling for a `derived` platform, null when never refreshed. */
  readonly derivedCapacityUnits: number | null;
  readonly derivedCapacityAt: Date | null;
}

function facebookCapacity(budget: AccountBudget): Capacity {
  return {
    kind: "derived",
    units: budget.derivedCapacityUnits,
    floor: FACEBOOK_CAPACITY_FLOOR,
    staleAfterMs: FACEBOOK_CAPACITY_STALE_MS,
    refreshedAt: budget.derivedCapacityAt,
  };
}

/**
 * The budgets one response draws from, and what it costs them.
 *
 * An empty bucket list means the platform meters nothing we can see, which is
 * not the same as free. The broker treats it as an unconditional grant, so it
 * belongs only where the platform genuinely publishes no limit for the call.
 */
export function responseBuckets(
  platform: Platform,
  action: ResponseAction,
  budget: AccountBudget
): ResponseCost {
  const account = { kind: "account", id: budget.accountExternalId } as const;
  const app = { kind: "app", id: budget.providerAppId } as const;

  switch (platform) {
    case "INSTAGRAM":
      // Only the private reply is capped. Instagram publishes no separate
      // ceiling for a comment reply, so charging one would invent a limit.
      if (action === "publicReply") return { buckets: [], cost: { units: 0 } };
      return {
        buckets: [
          {
            scope: account,
            meter: "meta:private_reply",
            window: { kind: "rolling", ms: 3_600_000 },
            capacity: { kind: "fixed", units: META_PRIVATE_REPLY_PER_HOUR },
          },
        ],
        cost: { units: 1 },
      };

    case "FACEBOOK":
      // One derived budget covers every Graph call on the Page, so the public
      // reply and the private reply draw from the same measured ceiling.
      return {
        buckets: [
          {
            scope: account,
            meter: "meta:page_calls",
            window: { kind: "rolling", ms: 24 * 3_600_000 },
            capacity: facebookCapacity(budget),
          },
        ],
        cost: { units: 1 },
      };

    case "YOUTUBE": {
      const buckets: BucketSpec[] = [
        {
          scope: app,
          meter: "youtube:units",
          window: { kind: "calendarDay", resetHourUtc: 8 },
          capacity: {
            kind: "pooled",
            units: 10_000,
            share: { participantKey: "account", floor: 144, reserve: 0.2 },
          },
          participantId: budget.accountExternalId,
        },
      ];

      // YouTube's spam policy names "high-volume, repetitive… comments… to
      // drive traffic", and the strike lands on the creator's channel rather
      // than on us. The daily pool alone does not stop one video absorbing the
      // whole budget, so replies are also capped per video.
      if (action === "publicReply" && budget.postId) {
        buckets.push({
          scope: { kind: "account", id: `${budget.accountExternalId}:${budget.postId}` },
          meter: "youtube:replies_per_video",
          window: { kind: "calendarDay", resetHourUtc: 8 },
          capacity: { kind: "fixed", units: REPLIES_PER_POST_PER_DAY.YOUTUBE },
        });
      }

      return { buckets, cost: { units: YOUTUBE_UNITS[action] } };
    }

    case "TIKTOK": {
      // Two levels at once. Both are per minute, and the broker co-locates them
      // so the pair is reserved atomically rather than two-phase.
      const buckets: BucketSpec[] = [
        {
          scope: account,
          meter: "tiktok:calls",
          window: { kind: "rolling", ms: 60_000 },
          capacity: { kind: "fixed", units: TIKTOK_ACCOUNT_PER_MINUTE },
        },
        {
          scope: app,
          meter: "tiktok:calls",
          window: { kind: "rolling", ms: 60_000 },
          capacity: { kind: "fixed", units: TIKTOK_APP_PER_MINUTE },
        },
      ];

      // The QPM tiers above are throughput, not volume. Neither stops one video
      // carrying hundreds of replies across a day, which is exactly the shape
      // TikTok flags as spam and hides without telling us.
      if (action === "publicReply" && budget.postId) {
        buckets.push({
          scope: { kind: "account", id: `${budget.accountExternalId}:${budget.postId}` },
          meter: "tiktok:replies_per_video",
          window: { kind: "calendarDay", resetHourUtc: 0 },
          capacity: { kind: "fixed", units: REPLIES_PER_POST_PER_DAY.TIKTOK },
        });
      }

      return { buckets, cost: { units: 1 } };
    }
  }
}
