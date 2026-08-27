/**
 * Facebook Pages. The adapter that proves the abstraction is worth its cost:
 * it is Instagram minus one capability, plus one, with two different constants
 * — and none of that is expressed as a branch in shared code.
 *
 *   loses  FOLLOW_GATE            no `is_user_follow_business` on Pages
 *   gains  PREFLIGHT_DM_ELIGIBILITY   `can_reply_privately` per comment
 *   window 7 days, not 24 hours
 *   quota  engagement-derived, not fixed
 *   token  never expires
 *
 * The follow gate becomes unconstructable on Facebook by the ceiling alone, so
 * a creator duplicating an Instagram campaign onto a Page gets a specific
 * compile error naming the follow gate, not a silent no-op at send time.
 */

import type {
  ConnectedAccount,
  DeliveryPlan,
  DeliveryReceipt,
  Failure,
  PlatformAdapter,
  ProviderApp,
  SweepSpec,
  WebhookIngest,
} from "./adapter";
import type { AccountCapabilities, AnyStep } from "./capability";
import type { BucketSpec } from "../runtime/quota";

/** "The message must be sent within 7 days from when the post or comment was created". */
export const FB_PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** "Calls within 24 hours = 4800 x Number of Engaged Users". */
export const FB_CALLS_PER_ENGAGED_USER = 4800;

export const facebookAdapter: PlatformAdapter<"facebook"> = {
  platform: "facebook",

  /**
   * Facebook Login for Business (`config_id`-driven), NOT consumer FB Login.
   * Scopes: pages_show_list, pages_manage_metadata, pages_messaging,
   * pages_read_engagement, pages_manage_engagement, business_management.
   *
   * This runs on its OWN `ProviderApp` row. One Meta app cannot hold both an
   * Instagram-Login setup and a Pages/Messenger setup — "You can only add one
   * setup per app" — and use cases are irreversible once added. Multiple
   * provider-app credentials are therefore a schema requirement, not a
   * convenience.
   */
  authorizeUrl(_app: ProviderApp, _redirectUri: string, _state: string): string {
    throw new Error("not implemented");
  },

  /**
   * Order matters: short-lived user token -> `fb_exchange_token` for a
   * long-lived user token -> `/{app-scoped-user-id}/accounts` for PAGE tokens.
   * Store the page id, the token, and `tasks` — the last is what tells us
   * whether MESSAGING was actually granted, which is the difference between a
   * connect that looks fine and a send that fails in production.
   */
  async connect() {
    throw new Error("not implemented");
  },

  /**
   * "Long-lived Page access token do not have an expiration date". Returns
   * `{ kind: "notNeeded" }` — the honest answer, and the reason token refresh
   * is a per-platform capability rather than a universal cron. It still
   * re-checks `/me/accounts` periodically, because Page tokens invalidate on
   * password change, permission revoke or role removal, and a silently dead
   * token is exactly what the admin overview exists to catch.
   */
  async refresh() {
    throw new Error("not implemented");
  },

  async negotiate(): Promise<AccountCapabilities<"facebook">> {
    // TODO: FOLLOW_GATE is declined with PLATFORM_LACKS_CAPABILITY and the
    // message "Facebook Pages expose no follow-status API; use Instagram for
    // follow-gated campaigns." A Page whose token lacks the MESSAGING task
    // declines DIRECT_MESSAGE / CONVERSATION_MESSAGE with SCOPE_NOT_GRANTED.
    throw new Error("not implemented");
  },

  ingest: {
    verifyChallenge() {
      throw new Error("not implemented");
    },
    /**
     * Signed with the META app secret — a DIFFERENT secret from the Instagram
     * route's. One route, one bound secret, per capability-matrix §7.
     */
    verifySignature() {
      throw new Error("not implemented");
    },
    /**
     * `object === "page"`, `changes[].field === "feed"`. Comments have no
     * dedicated field, so `feed` is extremely chatty (reactions, shares, photo
     * adds, status edits) and must be filtered first:
     *   keep only `item === "comment"` and `verb === "add"`
     *   drop `is_hidden === true`
     *   drop `from.id === entry.id`; `from` can be ABSENT — null-guard
     * `post_id` is `{page-id}_{post-id}`; `parent_id === post_id` marks a
     * top-level comment.
     *
     * `feed.value.from.id`'s scope is undocumented, so it is treated as opaque
     * and NEVER used as `recipient.id`. `comment_id` is the addressing token;
     * the real PSID comes back in the private-reply response and is persisted
     * from the receipt.
     *
     * Meta reportedly redelivers the same comment id; deduping happens for
     * free on `ResponseRun @@unique([campaignId, triggerKey])`.
     *
     * Log unknown `item` values: `reels` is not in the documented enum and the
     * reel-comment payload is unverified.
     */
    parse() {
      throw new Error("not implemented");
    },
  } satisfies WebhookIngest,

  /**
   * Reconcile only, and rarely. The engagement-derived budget means a
   * low-engagement Page has a genuinely small number of calls per day, so
   * enrichment GETs must be avoided in favour of webhook payload fields — and
   * sweeps are the first thing the scheduler stretches under pressure.
   */
  sweep: {
    priority: "safetyNet",
    costPerSweep: 1,
    baseIntervalMs: 15 * 60 * 1000,
    maxIntervalMs: 12 * 60 * 60 * 1000,
    lookbackMs: 7 * 24 * 60 * 60 * 1000,
    maxItemsPerSweep: 25,
  } satisfies SweepSpec,

  async runSweep() {
    throw new Error("not implemented");
  },

  async resolveNextPost() {
    throw new Error("not implemented");
  },

  /**
   * Same claim scope shape as Instagram — "Only one message can be sent to the
   * person who commented" — with a 7-day `expiresAt` instead of 24 hours. The
   * scope string differs (`fb:private_reply`) so the two platforms' ledgers
   * cannot collide on a shared comment id.
   *
   * Sets `preflight` on private-reply steps:
   * `GET /{comment-id}?fields=can_reply_privately`. This is the strongest
   * argument for putting "can I respond this way?" in the adapter: it turns a
   * question currently answered by a failed send and a regex over the error
   * string into a real question asked before the account's single allowed
   * reply is spent.
   */
  plan(
    _step: AnyStep<"facebook">,
    _run: unknown,
    _account: ConnectedAccount<"facebook">
  ): DeliveryPlan<"facebook"> {
    throw new Error("not implemented");
  },

  /**
   * `POST /{PAGE-ID}/messages` with `recipient: { comment_id }`. No
   * `messaging_type`, no tag — private reply is its own entry point. NOT the
   * legacy `/{object-id}/private_replies`, which needs a permission removed
   * after Graph v3.2.
   *
   * The response's `recipient_id` is the commenter's PSID and the only place
   * it is available; it is returned as `DeliveryReceipt.discoveredUserId` and
   * persisted, because it is what makes a later conversation message possible.
   *
   * Button templates work here too, so the same button -> inline-text fallback
   * applies; the fallback lives in this file, not in shared code, because the
   * error strings differ.
   */
  async deliver(): Promise<DeliveryReceipt> {
    throw new Error("not implemented");
  },

  /** Same Meta code taxonomy as Instagram, but the two adapters own their own copies. */
  classify(_error: unknown): Failure {
    throw new Error("not implemented");
  },

  /**
   * The DERIVED shape. `4800 x engaged users in the last 24 hours` — a budget
   * that is a function of live Page data, not a constant, and genuinely small
   * for a quiet Page.
   *
   *   { scope: {kind:"account", connectedAccountId},
   *     meter: "requests",
   *     window: {kind:"sliding", seconds: 86400},
   *     capacity: { kind: "derived",
   *                 units: FB_CALLS_PER_ENGAGED_USER * engagedUsers,
   *                 floor: 4800,             // one engaged user
   *                 staleAfterMs: 24h,
   *                 refreshedAt },
   *     onRefusal: "retryAfter",
   *     label: "Facebook Page 24h call budget" }
   *
   * `cred` is non-null here precisely because this bucket needs a live read.
   * Refreshed by the daily cron; while stale the broker uses `floor`, so the
   * failure mode is under-granting, never over-granting.
   */
  async quotaBuckets(): Promise<readonly BucketSpec[]> {
    throw new Error("not implemented");
  },

  // probeFollowStatus: absent. Facebook has no follow-status API.
};
