/**
 * Quota, as one concept with four configurations.
 *
 * The four platforms meter genuinely different things, and a single
 * `RATE_LIMIT_MAX` constant cannot express them:
 *
 *   Instagram  fixed, per account, 750 private replies an hour.
 *   Facebook   derived, per Page, 4800 x engaged users a day. The ceiling is a
 *              function of live Page data, not a constant, and a low-engagement
 *              Page has a genuinely small one.
 *   TikTok     two levels at once, 40 QPM per account and 600 QPM per app.
 *   YouTube    a single pool per Google Cloud project, 10,000 units a day shared
 *              across every creator, where a poll costs 1 and a reply costs 50.
 *              Sharding across projects to get more is forbidden by policy.
 *
 * The shapes that follow are the smallest set that covers all four without a
 * special case. YouTube is the one that forces `pooled`, because a per-account
 * limiter cannot express a ceiling that every tenant draws from.
 */

import { tryBindings } from "@/lib/cloudflare/bindings";

/** Who the budget belongs to. Pooled buckets are shared; the rest are not. */
export type BucketScope =
  | { readonly kind: "account"; readonly id: string }
  | { readonly kind: "app"; readonly id: string }
  | { readonly kind: "workspace"; readonly id: string };

export type Window =
  | { readonly kind: "rolling"; readonly ms: number }
  /** Resets at a wall-clock boundary. YouTube resets at midnight Pacific. */
  | { readonly kind: "calendarDay"; readonly resetHourUtc: number };

/**
 * How much there is to spend.
 *
 * `derived` falls back to `floor` both before the first refresh and whenever the
 * value is staler than `staleAfterMs`, so a Page whose engagement we have not
 * measured recently is under-granted rather than over-granted.
 */
export type Capacity =
  | { readonly kind: "fixed"; readonly units: number }
  | {
      readonly kind: "derived";
      readonly units: number | null;
      readonly floor: number;
      readonly staleAfterMs: number;
      readonly refreshedAt: Date | null;
    }
  | {
      readonly kind: "pooled";
      readonly units: number;
      readonly share: FairShare;
    };

/**
 * How a shared pool is divided.
 *
 * `reserve` is held back from the division because YouTube's costs are lopsided.
 * Polling is cheap and constant while a reply costs fifty times as much, so
 * without a reserve a quiet channel's poll budget gets divided away by a busy
 * one and it stops discovering comments entirely.
 */
export interface FairShare {
  readonly participantKey: "account" | "workspace";
  readonly floor: number;
  /** Fraction withheld from the per-participant division, 0 to 1. */
  readonly reserve: number;
}

export interface BucketSpec {
  readonly scope: BucketScope;
  /** What is counted. Distinct meters on one scope do not share a budget. */
  readonly meter: string;
  readonly window: Window;
  readonly capacity: Capacity;
  /**
   * Which participant to charge inside a pooled bucket. Ignored otherwise.
   * Pooled buckets track the pool and each participant in the same object, so
   * the two ledgers cannot disagree.
   */
  readonly participantId?: string;
}

/** What one operation costs. YouTube's list is 1 and its insert is 50. */
export interface Spend {
  readonly units: number;
}

export interface Refusal {
  readonly bucket: string;
  readonly remaining: number;
  /** Null when waiting cannot help, so the caller should skip rather than retry. */
  readonly retryAfterMs: number | null;
}

export type Reservation =
  | { readonly ok: true; readonly lease: Lease }
  | { readonly ok: false; readonly refusal: Refusal };

export interface Lease {
  readonly buckets: readonly string[];
  /**
   * `commit` keeps the debit and `release` refunds it. Both idempotent, so a
   * crashed consumer's retry cannot double-refund.
   */
  settle(outcome: "commit" | "release"): Promise<void>;
}

/**
 * The Durable Object that owns a bucket's ledger.
 *
 * Identity deliberately excludes the window and the capacity, which are policy
 * the object is told on each call. Raising Instagram's cap or refreshing
 * Facebook's derived ceiling must not orphan the running counter.
 */
export function bucketName(spec: BucketSpec): string {
  return `${spec.scope.kind}:${spec.scope.id}:${spec.meter}`;
}

/**
 * Group a spend into the objects that will serve it.
 *
 * Buckets that nest under a common scope are served by the coarsest one, so
 * TikTok's per-account and per-app levels are checked together in a single
 * atomic call rather than two-phase across two objects. The coarse object
 * serializes at the app scope, which is exactly where the platform already
 * serializes us, so it cannot become the bottleneck before TikTok does.
 */
export function colocate(spend: readonly BucketSpec[]): ReadonlyMap<string, BucketSpec[]> {
  const rank = { account: 0, workspace: 1, app: 2 } satisfies Record<BucketScope["kind"], number>;
  const groups = new Map<string, BucketSpec[]>();

  const coarsest = [...spend].sort((a, b) => rank[b.scope.kind] - rank[a.scope.kind])[0];
  const nests = coarsest?.scope.kind === "app";

  for (const bucket of spend) {
    const owner = nests && bucket.scope.kind !== "workspace" ? bucketName(coarsest) : bucketName(bucket);
    const existing = groups.get(owner);
    if (existing) existing.push(bucket);
    else groups.set(owner, [bucket]);
  }
  return groups;
}

interface BucketReply {
  allowed: boolean;
  used: number;
  remaining: number;
  retryAfterMs: number | null;
}

async function callBucket(
  owner: string,
  body: { buckets: BucketSpec[]; spend: Spend; op: "reserve" | "peek" | "release" }
): Promise<BucketReply | null> {
  const env = tryBindings();
  if (!env) return null;

  const stub = env.QUOTA.get(env.QUOTA.idFromName(owner));
  const response = await stub.fetch(
    new Request(`https://quota/${body.op}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  );
  if (!response.ok) throw new Error(`Quota bucket ${owner} returned ${response.status}`);
  // SAFETY: the object at the other end is QuotaBucket, whose every response
  // path returns this shape, and the status check above rejects anything else.
  return (await response.json()) as BucketReply;
}

/**
 * All or nothing across every bucket.
 *
 * Within a co-located group the reservation is atomic. Across groups it is
 * two-phase with compensating release, because Cloudflare has no cross-object
 * transaction and this does not pretend otherwise. The residual failure mode is
 * a brief over-refusal under contention, never an over-grant, which is the right
 * direction of error for a limit whose breach costs an app-level restriction.
 */
export async function reserve(
  spend: readonly BucketSpec[],
  cost: Spend
): Promise<Reservation> {
  if (spend.length === 0) {
    return { ok: true, lease: { buckets: [], settle: async () => {} } };
  }

  const groups = [...colocate(spend).entries()];
  const taken: string[] = [];

  for (const [owner, buckets] of groups) {
    const reply = await callBucket(owner, { buckets, spend: cost, op: "reserve" });

    // No binding means no Worker runtime, so there is no real API being
    // protected. Refusing here would turn a local run into a silent no-send.
    if (!reply) continue;

    if (!reply.allowed) {
      await Promise.all(
        taken.map((t) =>
          // SAFETY: `spend` is the readonly parameter this function received;
          // the cast drops readonly only so it fits the request body type.
          callBucket(t, { buckets: spend as BucketSpec[], spend: cost, op: "release" })
        )
      );
      return {
        ok: false,
        refusal: { bucket: owner, remaining: reply.remaining, retryAfterMs: reply.retryAfterMs },
      };
    }
    taken.push(owner);
  }

  return {
    ok: true,
    lease: {
      buckets: taken,
      async settle(outcome) {
        if (outcome === "commit") return;
        await Promise.all(
          taken.map((t) =>
            // SAFETY: as above, dropping readonly on a value we own.
            callBucket(t, { buckets: spend as BucketSpec[], spend: cost, op: "release" })
          )
        );
      },
    },
  };
}

/**
 * How close a bucket is to empty, from 0 to 1. The discovery scheduler is a pure
 * function of this, so quota-aware pacing is testable without a Durable Object.
 */
export async function pressure(spend: readonly BucketSpec[]): Promise<number> {
  if (spend.length === 0) return 0;

  const readings = await Promise.all(
    [...colocate(spend).entries()].map(([owner, buckets]) =>
      callBucket(owner, { buckets, spend: { units: 0 }, op: "peek" })
    )
  );

  const known = readings.filter((r): r is BucketReply => r !== null);
  if (known.length === 0) return 0;

  return Math.max(
    ...known.map((r) => {
      const total = r.used + r.remaining;
      return total === 0 ? 0 : r.used / total;
    })
  );
}
