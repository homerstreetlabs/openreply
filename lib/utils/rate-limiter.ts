/**
 * Per-account send limiter, on a Durable Object.
 *
 * The cap matches Meta's documented limit for this exact call: 750 private
 * replies per hour per Instagram professional account. Exceeding it risks 429s
 * and app-level restrictions, so the worker requeues rather than pushing
 * through.
 * https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
 *
 * Was a Redis Lua `EVAL`. The Lua bought atomicity; a Durable Object's
 * single-threaded execution provides the same guarantee, verified under 4x
 * oversubscription (40 concurrent requests against a cap of 10 granted exactly
 * 10). See docs/architecture/SPIKE-RESULTS.md.
 *
 * The Workers Rate Limiting binding is not usable here and the reason is in its
 * own documentation: `period` must be 10 or 60 seconds so 750/hour is
 * inexpressible, counters are local to a Cloudflare location so the real cap
 * would be 750 times the number of PoPs, and it is "intentionally designed to
 * not be used as an accurate accounting system".
 */

import { pressure, reserve } from "@/lib/runtime/quota";
import { responseBuckets, type AccountBudget } from "@/lib/runtime/send-quota";
import type { Platform } from "@/app/generated/prisma/client";

const REQUEUE_DELAY_MS = 30 * 60 * 1000;
const MAX_REQUEUE_ATTEMPTS = 3;

export interface RateLimitResult {
  allowed: boolean;
  /**
   * What the refusing bucket had left, or null on a grant.
   *
   * Null rather than the ceiling, because three of the four platforms have no
   * single ceiling to report: Facebook's is measured, YouTube's is a pooled
   * share, and TikTok has two at once. Reporting a constant here is how the
   * send path came to charge every platform Instagram's 750.
   */
  remaining: number | null;
  shouldRequeue: boolean;
  requeueDelayMs: number;
  shouldSkip: boolean;
  reserved: boolean;
}

function blockedResult(remaining: number, requeueAttempt: number): RateLimitResult {
  if (requeueAttempt >= MAX_REQUEUE_ATTEMPTS) {
    return {
      allowed: false,
      remaining,
      shouldRequeue: false,
      requeueDelayMs: 0,
      shouldSkip: true,
      reserved: false,
    };
  }
  return {
    allowed: false,
    remaining,
    shouldRequeue: true,
    requeueDelayMs: REQUEUE_DELAY_MS,
    shouldSkip: false,
    reserved: false,
  };
}

/**
 * Atomically reserve a send slot. The Durable Object serializes callers, so
 * concurrent consumers cannot all pass the check before any of them increments.
 */
export async function reserveDMSlot(
  platform: Platform,
  budget: AccountBudget,
  requeueAttempt: number = 0
): Promise<RateLimitResult> {
  const { buckets, cost } = responseBuckets(platform, "privateReply", budget);
  const result = await reserve(buckets, cost);

  if (!result.ok) {
    return blockedResult(result.refusal.remaining, requeueAttempt);
  }

  return {
    allowed: true,
    remaining: null,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: result.lease.buckets.length > 0,
  };
}

/**
 * How full the send budget is, 0 to 1.
 *
 * Replaces a pair of exports that reported a count and a remainder against a
 * hardcoded 750. Three of the four platforms have no single ceiling to count
 * against, and neither export had a caller outside its own tests.
 */
export async function sendPressure(
  platform: Platform,
  budget: AccountBudget
): Promise<number> {
  const { buckets } = responseBuckets(platform, "privateReply", budget);
  return pressure(buckets);
}

export { REQUEUE_DELAY_MS, MAX_REQUEUE_ATTEMPTS };
