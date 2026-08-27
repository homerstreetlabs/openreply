/**
 * The quota broker: one concept covering the four rate-limit shapes in the
 * capability matrix, plus the workspace plan cap, as data.
 *
 *   Instagram  fixed          per-account, 750/hour
 *   Facebook   derived        per-account, 4800 x engaged users / 24h
 *   TikTok     two-level      per-account 40 QPM AND per-app 600 QPM
 *   YouTube    pooled         per-Google-Cloud-project 10,000 units/day,
 *                             shared across EVERY tenant, cost 1..50 per call
 *   Workspace  fixed          per-workspace, per calendar month  (today's
 *                             `reserveWorkspaceDMSend`)
 *
 * A `RATE_LIMIT_MAX` constant cannot express those. What can: a debit of
 * `cost` units against an ordered list of buckets, where a bucket is
 * (scope, meter, window, capacity, refusal policy). None of the four is a
 * special case; TikTok's two-level shape is a two-element array, and YouTube's
 * pool is the `pooled` capacity kind — the only one that also enforces a
 * per-tenant sub-ceiling, because a shared pool without fair-share means
 * whichever tenant polls first starves the rest.
 *
 * Collapsing today's TWO reservations (workspace month + account hour) into one
 * call removes the paired `releaseWorkspaceDMReservation` calls scattered
 * through the send path: one `lease.settle()` in a `finally` replaces all of
 * them.
 */

import type { PlatformId } from "../platform/capability";

/** Units. 1 for a Meta call; 50 for `comments.insert`; 1 for a YouTube list. */
export type QuotaCost = number;

/**
 * What is being metered. Separate meters on the same scope do not share a
 * budget: TikTok's 40 QPM is per-endpoint *requests*, Instagram's 750/hr is
 * *sends*, YouTube's 10,000 is *units*.
 */
export type Meter = "sends" | "requests" | "units";

export type BucketScope =
  | { readonly kind: "account"; readonly connectedAccountId: string }
  /** Shared by every account on one set of app credentials. */
  | { readonly kind: "providerApp"; readonly providerAppId: string }
  /** The billing tenant. Today's monthly DM allowance. */
  | { readonly kind: "workspace"; readonly workspaceId: string };

export type Window =
  | { readonly kind: "sliding"; readonly seconds: number }
  /**
   * Resets at local midnight in `tz`. YouTube resets at midnight
   * America/Los_Angeles — a detail a `seconds`-only window silently gets wrong
   * for most of the day.
   */
  | { readonly kind: "calendarDay"; readonly tz: string }
  | { readonly kind: "calendarMonth"; readonly tz: string };

export type Capacity =
  | { readonly kind: "fixed"; readonly units: number }
  /**
   * A budget that is a function of live platform data. Facebook: 4800 x
   * engaged users in the last 24h. Refreshed by a daily cron calling
   * `adapter.quotaBuckets`; the broker uses `floor` until the first refresh
   * lands and whenever the value is older than `staleAfterMs`, so a
   * low-engagement Page is never over-granted.
   */
  | {
      readonly kind: "derived";
      readonly units: number | null;
      readonly floor: number;
      readonly staleAfterMs: number;
      readonly refreshedAt: Date | null;
    }
  /**
   * A single pool shared by every tenant on one provider app, with a
   * per-tenant sub-ceiling so no tenant can drain it. YouTube only, and the
   * reason YouTube is not a bolt-on: `share` is enforced in the SAME
   * single-threaded object as the pool, so the two ledgers cannot disagree.
   */
  | {
      readonly kind: "pooled";
      readonly units: number;
      readonly share: FairShare;
    };

export interface FairShare {
  /** Ceiling per participant = max(floor, units * (1 - reserve) / participants). */
  readonly participantKey: "connectedAccountId" | "workspaceId";
  readonly floor: number;
  /**
   * Fraction of the pool held back from the fair-share division and handed out
   * first-come. YouTube: polling is cheap and constant, sends are 50x, so the
   * reserve stops a quiet channel's poll budget being divided away.
   */
  readonly reserve: number;
}

export interface BucketSpec {
  readonly scope: BucketScope;
  readonly meter: Meter;
  readonly window: Window;
  readonly capacity: Capacity;
  /**
   * `"retryAfter"` — a renewable window; the engine requeues (Instagram's hour,
   * TikTok's minute).
   * `"skip"` — the budget will not reopen usefully soon; the engine records a
   * terminal skip (workspace month, YouTube day).
   */
  readonly onRefusal: "retryAfter" | "skip";
  /** Human string used verbatim in the run outcome and the admin view. */
  readonly label: string;
  /** Present for observability only; never branched on. */
  readonly platform: PlatformId | null;
}

/**
 * The identity of the Durable Object that owns this bucket's ledger. Derived,
 * never stored — two specs describing the same bucket must produce the same
 * name or the ledger splits.
 */
export function bucketName(spec: BucketSpec): string {
  // TODO: `${scope.kind}:${id}:${meter}` — deliberately excludes window and
  // capacity, which are POLICY the DO is told on each call, not identity. That
  // way raising Instagram's cap or refreshing Facebook's derived budget does
  // not orphan the running counter.
  throw new Error("not implemented");
}

/**
 * Which Durable Object OWNS a bucket's ledger.
 *
 * GRAFTED from arena candidate 4. `bucketName` identifies a bucket; this
 * identifies its home, and the two are deliberately not the same function.
 *
 * The problem it solves: TikTok's limits are two-level — 40 QPM per authorized
 * account AND 600 QPM across the whole app. Reserving those as two independent
 * Durable Objects means two-phase reservation with compensating release, which
 * is correct but always slightly wrong under contention (a brief over-refusal
 * when the second bucket denies after the first granted).
 *
 * The observation: buckets in one spend that share a scope HIERARCHY can live
 * in one object, named by the COARSEST scope in the spend. The app-scoped DO
 * already serializes every account under that app, so it can hold the
 * per-account counters too and check both in a single atomic call. Nothing is
 * two-phase, so nothing needs compensating.
 *
 * Why the coarse object does not become the bottleneck: it serializes at the
 * app scope, which is exactly where the platform ALREADY serializes us — TikTok
 * caps the app at 600 QPM, or 10/second. A Durable Object handles on the order
 * of a thousand requests per second. We hit TikTok's ceiling roughly two orders
 * of magnitude before we hit the object's.
 *
 * Where it does NOT apply, and why that is fine:
 *   - Instagram: one account-scoped bucket. Its own object; no hierarchy.
 *   - YouTube: the pool and the per-tenant share are ALREADY one `pooled`
 *     bucket in one object — that co-location is the whole reason the two
 *     ledgers cannot disagree. Unchanged by this graft.
 *   - The workspace monthly cap crosses platforms and does not nest under a
 *     provider app, so it stays independent and is reserved two-phase. One
 *     genuinely independent bucket is the residual case, and `reserve` still
 *     handles it.
 */
export function ownerName(spend: readonly BucketSpec[]): string {
  // TODO: pick the coarsest scope present in `spend` — pool > app > workspace >
  // account — and return `bucketName` of that spec. Every bucket in the spend
  // that NESTS under it is carried in the same call as a sub-ledger keyed by its
  // own `bucketName`. Buckets that do not nest form their own groups.
  throw new Error("not implemented");
}

/**
 * Partition a spend into co-location groups. One group = one Durable Object =
 * one atomic call. A spend of size N yields N groups in the worst case (all
 * independent) and one in the best (fully nested, e.g. TikTok).
 */
export function colocate(
  spend: readonly BucketSpec[]
): readonly { readonly owner: string; readonly buckets: readonly BucketSpec[] }[] {
  throw new Error("not implemented");
}

// ─── Reservation ─────────────────────────────────────────────────────────────

export interface Lease {
  readonly id: string;
  readonly buckets: readonly string[];
  readonly cost: QuotaCost;
  /**
   * `commit` keeps the debit; `release` refunds it. Idempotent by lease id, so
   * a crashed worker's retry cannot double-refund. Uncommitted leases expire
   * on the DO's alarm, which is what stops a crash between reserve and send
   * from leaking budget forever.
   */
  settle(outcome: "commit" | "release"): Promise<void>;
}

export interface Refusal {
  readonly bucket: BucketSpec;
  readonly remaining: number;
  /** Null when `onRefusal` is `"skip"`. */
  readonly retryAfterMs: number | null;
}

export type Reservation =
  | { readonly ok: true; readonly lease: Lease }
  | { readonly ok: false; readonly refusal: Refusal };

export interface QuotaBroker {
  /**
   * All-or-nothing across every bucket.
   *
   * `colocate()` first partitions the spend into groups that share a Durable
   * Object. Within a group the reservation IS atomic — one call, one
   * single-threaded object, both levels checked together. TikTok's two levels
   * therefore collapse to one group and never need compensating release.
   *
   * ACROSS groups it remains two-phase: groups are reserved in order (adapters
   * list scarcest first) and already-taken leases are released on a refusal
   * partway through. There is no cross-DO transaction on Cloudflare and this
   * design does not pretend otherwise. The residual failure mode is a brief
   * over-refusal under contention — never an over-grant, which is the correct
   * direction of error for a limit whose breach costs an app-level restriction.
   *
   * In practice the common spends are one group: Instagram one bucket, TikTok
   * two nested, YouTube one pooled bucket holding both pool and share. Only a
   * spend that also charges the cross-platform workspace cap is multi-group.
   */
  reserve(cost: QuotaCost, buckets: readonly BucketSpec[]): Promise<Reservation>;

  /**
   * Read-only forecast used by the sweep scheduler to lengthen intervals under
   * pressure. Cheap: a single DO read per bucket, no reservation taken.
   */
  pressure(buckets: readonly BucketSpec[]): Promise<BudgetPressure>;

  /** Mirrored into Postgres by a cron so the admin view can render it. */
  snapshot(buckets: readonly BucketSpec[]): Promise<readonly BucketSnapshot[]>;
}

/**
 * 0 = budget untouched, 1 = exhausted. The scheduler is a pure function of
 * this, so quota-aware scheduling is unit-testable without a Durable Object.
 */
export type BudgetPressure = number;

export interface BucketSnapshot {
  readonly name: string;
  readonly label: string;
  readonly used: number;
  readonly capacity: number;
  readonly windowResetsAt: Date;
  /** Set on a `pooled` bucket: this participant's own sub-ceiling and usage. */
  readonly share: { readonly used: number; readonly ceiling: number } | null;
}

// ─── The Durable Object ──────────────────────────────────────────────────────

/**
 * `QuotaBucket` — one instance per `bucketName`, addressed with
 * `env.QUOTA.idFromName(name)`. Storage is DO SQLite.
 *
 * Why a Durable Object and not the Workers Rate Limiting binding: that binding
 * is disqualified by its own docs — `period` must be 10 or 60 seconds (cannot
 * express 750/hour), it is local to a Cloudflare location (750 x hundreds of
 * PoPs), and it is "intentionally designed to not be used as an accurate
 * accounting system".
 *
 * Why not Redis: there is no managed Redis on Cloudflare. Today's
 * `RESERVE_DM_SLOT_SCRIPT` Lua ports near line-for-line, because the DO's
 * single-threaded execution IS the atomicity `EVAL` was buying.
 */
export interface QuotaBucketStub {
  /** Serialized by the DO's single-threaded execution. */
  reserve(req: {
    readonly leaseId: string;
    readonly cost: QuotaCost;
    readonly window: Window;
    readonly capacity: Capacity;
    /** Present for pooled buckets: whose sub-ceiling to charge. */
    readonly participantId: string | null;
    readonly leaseTtlMs: number;
  }): Promise<{ readonly ok: boolean; readonly remaining: number; readonly resetsAt: number }>;

  settle(leaseId: string, outcome: "commit" | "release"): Promise<void>;
  read(window: Window, capacity: Capacity, participantId: string | null): Promise<BucketSnapshot>;

  /** For a pooled bucket: how many participants are currently active. */
  setParticipantCount(n: number): Promise<void>;
}
