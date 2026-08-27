/**
 * YouTube. The adapter that proves the abstraction, because it can do exactly
 * one thing.
 *
 * There is no messaging API. Not a gated one, not a partner one — the Data API
 * v3 has no messaging resource, and the `comment` resource exposes no
 * identifier a message could be routed to (`authorDisplayName`,
 * `authorProfileImageUrl`, `authorChannelUrl`, `authorChannelId.value`). So
 * `PlatformCeiling["youtube"]` is the single string `"PUBLIC_REPLY"`, and:
 *
 *   - `StepsAvailableOn<"youtube">` is `"publicReply"`. `builders("youtube")`
 *     has one property. A DM, a button, a follow gate or a read fallback is
 *     not something this adapter refuses — it is something no caller can
 *     construct.
 *   - `plan()` below takes `AnyStep<"youtube">`, which is
 *     `Step<"youtube","publicReply">`. Its switch has ONE case and the compiler
 *     proves it exhaustive. There is no `default: return` and no DM stub.
 *   - `probeFollowStatus` and `ingest` are simply absent/null. Not stubs that
 *     throw — absent members.
 *
 * That is the difference between `if (platform === "youtube") return;` in the
 * send path and a platform that never advertises the capability.
 */

import type {
  ConnectedAccount,
  DeliveryPlan,
  DeliveryReceipt,
  Failure,
  PlatformAdapter,
  ProviderApp,
  SweepSpec,
} from "./adapter";
import type { AccountCapabilities, AnyStep } from "./capability";
import type { BucketSpec } from "../runtime/quota";

/** `comments.insert` costs 50 units. `commentThreads.list` costs 1. */
export const YT_COST_REPLY = 50;
export const YT_COST_LIST = 1;
/** Default per Google Cloud project, per day, resetting at midnight PT. */
export const YT_DAILY_UNITS = 10_000;

export const youtubeAdapter: PlatformAdapter<"youtube"> = {
  platform: "youtube",

  /**
   * Scope is `youtube.force-ssl` — the only write scope that exists, and it
   * reads badly on the consent screen ("See, edit, and permanently delete your
   * YouTube videos, ratings, comments and captions"). There is no narrower
   * option; the connect UI must say so up front rather than let a creator be
   * surprised by the Google dialog.
   */
  authorizeUrl(_app: ProviderApp, _redirectUri: string, _state: string): string {
    throw new Error("not implemented");
  },

  async connect() {
    throw new Error("not implemented");
  },

  /** Refresh token; in Testing publishing status it expires after 7 days. */
  async refresh() {
    throw new Error("not implemented");
  },

  /**
   * Always `{ PUBLIC_REPLY }`, with an explicit `declined` entry for every
   * other ceiling capability of every other platform the UI might ask about —
   * so the campaign builder can say "YouTube has no messaging API of any kind"
   * rather than showing a disabled toggle with no explanation.
   *
   * `copyPolicy` carries `noIncentivisedCommentCta`, because Developer Policy
   * §III.F makes "comment LINK below and I'll DM you the guide" prohibited
   * here independent of delivery. This is the clause that changes the product,
   * not just the plumbing.
   */
  async negotiate(): Promise<AccountCapabilities<"youtube">> {
    throw new Error("not implemented");
  },

  /**
   * No comment webhook exists. WebSub fires on exactly three events — video
   * uploaded, title updated, description updated — and comments are not among
   * them. `null` is the honest value and the scheduler reads it: with
   * `ingest === null`, `sweep.priority` MUST be `"primary"`, which is asserted
   * at registry load.
   */
  ingest: null,

  /**
   * Poll-only and metered. `commentThreads.list` with
   * `allThreadsRelatedToChannelId` returns comments across every video of the
   * channel in ONE call for 1 unit, which is what makes this affordable at
   * all. `search.list` is never used — it has its own 100-calls/day bucket.
   *
   * `baseIntervalMs` of 3 minutes and `maxIntervalMs` of 30 minutes bracket
   * the quota table: at 25 channels with ~100 replies/day the sustainable
   * interval is around 7 minutes, and the scheduler finds that number itself
   * from live pressure rather than from an env var.
   */
  sweep: {
    priority: "primary",
    costPerSweep: YT_COST_LIST,
    baseIntervalMs: 3 * 60 * 1000,
    maxIntervalMs: 30 * 60 * 1000,
    lookbackMs: 24 * 60 * 60 * 1000,
    maxItemsPerSweep: 100,
  } satisfies SweepSpec,

  async runSweep() {
    throw new Error("not implemented");
  },

  /** `channels.list` -> `contentDetails.relatedPlaylists.uploads` -> `playlistItems.list`. */
  async resolveNextPost() {
    throw new Error("not implemented");
  },

  /**
   * One case. `step.kind` is `"publicReply"` and nothing else, by type.
   *
   *   claims:  []                    a public reply consumes no one-shot
   *   buckets: [the project pool]    shared across every tenant
   *   cost:    YT_COST_REPLY (50)
   */
  plan(
    _step: AnyStep<"youtube">,
    _run: unknown,
    _account: ConnectedAccount<"youtube">
  ): DeliveryPlan<"youtube"> {
    throw new Error("not implemented");
  },

  /** `comments.insert` with `snippet.parentId = <top-level comment id>`. */
  async deliver(): Promise<DeliveryReceipt> {
    throw new Error("not implemented");
  },

  /**
   *   quotaExceeded / rateLimitExceeded -> RATE_LIMITED, retryAfter = ms to
   *     midnight America/Los_Angeles. attempted "no".
   *   invalid_grant / 401               -> TOKEN_INVALID,  incident TOKEN_EXPIRED
   *   403 forbidden                     -> PERMISSION_DENIED
   *   commentsDisabled / processingFailure -> INELIGIBLE, attempted "no"
   *   5xx                               -> RETRYABLE
   */
  classify(_error: unknown): Failure {
    throw new Error("not implemented");
  },

  /**
   * The pooled shape, and the reason it is a first-class capacity kind rather
   * than a special case.
   *
   * The budget is per Google Cloud PROJECT, shared across every tenant, and
   * sharding across projects is explicitly forbidden by Developer Policies
   * §III.D. At 50 units a reply that is a hard ceiling of 200 automated
   * replies per day for the entire product. Without a per-tenant sub-ceiling,
   * whichever tenant's campaign fires first spends the day's budget and every
   * other creator silently gets nothing — a failure mode a per-account limiter
   * cannot even represent.
   *
   *   { scope:  { kind: "providerApp", providerAppId: app.id },
   *     meter:  "units",
   *     window: { kind: "calendarDay", tz: "America/Los_Angeles" },
   *     capacity: { kind: "pooled", units: YT_DAILY_UNITS,
   *                 share: { participantKey: "connectedAccountId",
   *                          floor: 100, reserve: 0.3 } },
   *     onRefusal: "skip",
   *     label: "YouTube daily project quota" }
   *
   * `reserve: 0.3` holds back 30% from the fair-share division so a quiet
   * channel's 1-unit polls are never divided away by a busy channel's 50-unit
   * replies.
   */
  async quotaBuckets(): Promise<readonly BucketSpec[]> {
    throw new Error("not implemented");
  },

  /**
   * Present because YouTube silently holds templated, link-bearing replies for
   * review, and the customer's own channel eats the spam strike. Re-read our
   * reply and look for `moderationStatus=heldForReview`; a hold raises the
   * same cross-platform `POLICY_HOLD` incident TikTok's shadow-hide detection
   * raises, so the admin view shows one concept, not two.
   */
  async checkDeliveryVisibility() {
    throw new Error("not implemented");
  },

  // probeFollowStatus: deliberately absent.
};
