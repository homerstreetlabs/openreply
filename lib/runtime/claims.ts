/**
 * Exclusive claims, which generalise Instagram's one-private-reply-per-comment
 * rule without hoisting that rule into the core.
 *
 * The rule stated platform-neutrally: some deliveries consume a scarce,
 * externally owned, one-shot resource identified by a key. Instagram allows one
 * private reply per comment, ever, across every campaign. Facebook says the same
 * sentence with a 7-day window. TikTok requires the comment not to have been
 * answered by DM in any way. YouTube consumes nothing, because a public reply is
 * not scarce.
 *
 * So the core owns the mechanism (take a key before sending, at most one holder,
 * ever) and each adapter owns the policy (which keys, if any, a step consumes).
 * Facebook gets the rule for free by returning the same shape. YouTube returns
 * an empty list and never touches the ledger. There is no `if` in the engine.
 *
 * This replaces a findFirst-then-update, which two concurrent consumers both
 * pass. Cloudflare Queues delivers at least once and has no dedup key, so that
 * race was reachable in production.
 */

import { prisma } from "@/lib/db/client";

export interface ExclusiveClaim {
  /** Namespaced so two platforms cannot collide on a shared id space. */
  readonly scope: string;
  /** The platform's own id for the thing being consumed. */
  readonly key: string;
}

/**
 * How long a claim stays held while the send's outcome is unknown.
 *
 * Longer than the queue's own retry ladder (300 + 900 + 2700 seconds), so a run
 * still retrying cannot have its claim taken by a different campaign. Far
 * shorter than any platform's reply window, so a genuinely lost send still has
 * most of the window left to be retried in.
 */
const UNSETTLED_HOLD_MS = 2 * 3600_000;

export type ClaimResult =
  | { readonly held: true; readonly firstAcquired: boolean }
  | {
      readonly held: false;
      readonly holderCampaignId: string | null;
      readonly holderCampaignName: string | null;
    };

/**
 * Whether the platform acted, which decides what happens to the claim.
 *
 * `"yes"` settles it forever, because the one-shot is spent. `"no"` frees it
 * immediately. `"unknown"` does neither: releasing at once would let a second
 * campaign burn a call on a comment that can never accept one, and holding
 * forever would forfeit a reply nobody ever sent. So it keeps the lease and
 * lets it lapse.
 */
export type Attempted = "yes" | "no" | "unknown";

/**
 * Take every claim for this run, or none.
 *
 * Re-acquiring a claim this run already holds is a no-op reporting
 * `firstAcquired: false`, which is what makes a queue redelivery safe. An empty
 * list is held trivially, so a platform that consumes nothing needs no special
 * case at the call site.
 */
export async function acquireClaims(
  claims: readonly ExclusiveClaim[],
  campaignId: string,
  runKey: string
): Promise<ClaimResult> {
  if (claims.length === 0) return { held: true, firstAcquired: true };

  const taken: ExclusiveClaim[] = [];
  const now = new Date();

  // A lapsed lease is a claim whose holder never came back to say what the
  // platform did. Clearing it here rather than on a timer means the cost is paid
  // by whoever actually wants the claim, and only when they want it.
  await prisma.deliveryClaim.deleteMany({
    where: {
      reclaimableAt: { not: null, lte: now },
      OR: claims.map((c) => ({ scope: c.scope, key: c.key })),
    },
  });

  for (const claim of claims) {
    try {
      await prisma.deliveryClaim.create({
        data: {
          scope: claim.scope,
          key: claim.key,
          campaignId,
          runKey,
          reclaimableAt: new Date(now.getTime() + UNSETTLED_HOLD_MS),
        },
      });
      taken.push(claim);
    } catch {
      // The unique constraint is the mutual exclusion. A create that loses the
      // race lands here, and so does this run's own earlier attempt.
      const holder = await prisma.deliveryClaim.findUnique({
        where: { scope_key: { scope: claim.scope, key: claim.key } },
        select: {
          runKey: true,
          campaignId: true,
          campaign: { select: { name: true } },
        },
      });

      if (holder?.runKey === runKey && holder.campaignId === campaignId) {
        taken.push(claim);
        continue;
      }

      await releaseClaims(taken, runKey);
      return {
        held: false,
        holderCampaignId: holder?.campaignId ?? null,
        holderCampaignName: holder?.campaign?.name ?? null,
      };
    }
  }

  return { held: true, firstAcquired: true };
}

/**
 * Release claims for a delivery the platform provably did not attempt.
 *
 * Scoped to `runKey` so a run can only release what it took, which is what stops
 * a losing campaign from freeing the winner's claim.
 */
export async function releaseClaims(
  claims: readonly ExclusiveClaim[],
  runKey: string
): Promise<void> {
  if (claims.length === 0) return;
  await prisma.deliveryClaim.deleteMany({
    where: {
      runKey,
      OR: claims.map((c) => ({ scope: c.scope, key: c.key })),
    },
  });
}

/** Release only on a proven non-attempt. See `Attempted`. */
export async function releaseIfUnattempted(
  claims: readonly ExclusiveClaim[],
  runKey: string,
  attempted: Attempted
): Promise<void> {
  if (attempted !== "no") return;
  await releaseClaims(claims, runKey);
}

/**
 * Make a claim permanent, because the platform provably acted.
 *
 * The counterpart to the lease `acquireClaims` takes. Until this runs the claim
 * lapses on its own, which is what stops a crash between the send and this call
 * from forfeiting the comment's only reply.
 */
export async function settleClaims(
  claims: readonly ExclusiveClaim[],
  runKey: string
): Promise<void> {
  if (claims.length === 0) return;
  await prisma.deliveryClaim.updateMany({
    where: {
      runKey,
      OR: claims.map((c) => ({ scope: c.scope, key: c.key })),
    },
    data: { reclaimableAt: null },
  });
}

/**
 * Whether a failed send reached the platform.
 *
 * A rejected button template was still delivered as a request, so Meta has
 * already spent the comment's reply. A refusal before the request went out did
 * not. Anything unrecognised is `"unknown"`, which holds the claim.
 */
const NOT_ATTEMPTED = [
  /rate limit/i,
  /failed to decrypt/i,
  /no access token/i,
  /bindings are unavailable/i,
];

export function classifyAttempt(error: unknown): Attempted {
  const message = error instanceof Error ? error.message : String(error);
  return NOT_ATTEMPTED.some((p) => p.test(message)) ? "no" : "unknown";
}
