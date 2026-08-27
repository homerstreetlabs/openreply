/**
 * How often to look for new comments, per connected account.
 *
 * Discovery is not one mechanism. Instagram and Facebook push webhooks and the
 * sweep is a safety net for the ones Meta never sends. TikTok pushes a webhook
 * that already carries the comment text, so a sweep is only ever a
 * reconciliation. YouTube has no comment webhook at all, so the sweep is the
 * only path and every pass costs metered quota from a pool shared with every
 * other creator.
 *
 * A single interval cannot serve those. The scheduler degrades by looking less
 * often rather than by failing, because on YouTube a refusal means comments are
 * simply never discovered.
 */

import type { PlatformAdapter } from "@/lib/platforms/types";
import type { BucketSpec } from "@/lib/runtime/quota";

export interface SweepPlan {
  /** Seconds until this account should be swept again. */
  readonly intervalSeconds: number;
  /** What one pass costs, in the platform's own units. */
  readonly cost: number;
  /**
   * True when the sweep is the only way comments arrive. A primary sweep never
   * stops entirely; it only slows down.
   */
  readonly primary: boolean;
}

const MIN_INTERVAL_SECONDS = 300;
const MAX_INTERVAL_SECONDS = 3600;

/**
 * Pure, so pacing is testable without a Durable Object or a network.
 *
 * `pressure` runs 0 to 1. At zero the interval is the floor. As the budget fills
 * the interval stretches toward the ceiling, so a platform under quota pressure
 * looks less often instead of erroring.
 */
export function sweepIntervalSeconds(pressure: number, primary: boolean): number {
  const clamped = Math.min(1, Math.max(0, pressure));

  // A safety-net sweep may stop; a primary one may not, because stopping means
  // the platform's comments are never seen at all.
  if (!primary && clamped >= 1) return MAX_INTERVAL_SECONDS;

  const span = MAX_INTERVAL_SECONDS - MIN_INTERVAL_SECONDS;
  return Math.round(MIN_INTERVAL_SECONDS + span * clamped);
}

/**
 * What a sweep of this account costs and how often it can afford to run.
 *
 * Reads `discovery.kind` rather than the platform name, so a fifth platform
 * paces itself by declaring its discovery rather than by being added here.
 */
export function planSweep(adapter: PlatformAdapter, pressure: number): SweepPlan {
  const primary = adapter.discovery.kind === "poll";
  const cost = adapter.discovery.kind === "poll" ? adapter.discovery.pollCost : 0;

  return {
    intervalSeconds: sweepIntervalSeconds(pressure, primary),
    cost,
    primary,
  };
}

/**
 * The quota a single discovery pass spends.
 *
 * Empty for webhook platforms, whose sweep is a safety net against an API that
 * does not meter it the way YouTube does. Pooled for YouTube, because the
 * 10,000 units a day belong to the Google Cloud project rather than to any one
 * creator, and a fair share is what stops one viral channel starving the rest.
 */
export function discoveryBuckets(
  adapter: PlatformAdapter,
  accountExternalId: string,
  providerAppId: string
): BucketSpec[] {
  if (adapter.discovery.kind !== "poll") return [];

  return [
    {
      scope: { kind: "app", id: providerAppId },
      meter: `${adapter.platform.toLowerCase()}:units`,
      // YouTube's quota resets at midnight Pacific, which is 08:00 UTC.
      window: { kind: "calendarDay", resetHourUtc: 8 },
      capacity: {
        kind: "pooled",
        units: 10_000,
        share: {
          participantKey: "account",
          // Enough for one poll every ten minutes for a whole day, so a quiet
          // channel keeps discovering even when a busy one spends the pool.
          floor: 144,
          // Held back from the division. Polls cost 1 and replies cost 50, so
          // without this a channel posting replies divides away everyone's
          // ability to look.
          reserve: 0.2,
        },
      },
      participantId: accountExternalId,
    },
  ];
}
