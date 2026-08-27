/**
 * TikTok. The adapter that proves capabilities are PER-ACCOUNT, not
 * per-platform.
 *
 * Two creators in the same workspace, on the same platform, on the same app
 * credentials, can have different capability sets — because TikTok gates
 * Business Messaging by the account's registration region:
 *
 *   VN / ID / TH   comment->DM exists, but TikTok's own high-intent classifier
 *                  decides which comments qualify, not our keyword. We do not
 *                  advertise it as a keyword capability, because it would be a
 *                  lie: a creator would configure a keyword and TikTok would
 *                  ignore it.
 *   EEA / CH / UK  Business Messaging is unavailable entirely.
 *   US            comment->DM never reaches these accounts, and messaging at
 *                  all requires the USDS addendum.
 *   elsewhere      inbound-triggered DM works (48h window, 10 messages).
 *
 * So `negotiate()` returns `CONVERSATION_MESSAGE` and
 * `INBOUND_MESSAGE_TRIGGER` only where the account's region permits, with the
 * `DeclineReason` quoting TikTok verbatim. `PUBLIC_REPLY` ships everywhere.
 * That state has no representation in the current schema and cannot be an env
 * var — capability-matrix §4.
 *
 * `DIRECT_MESSAGE` is absent from the ceiling entirely, because "You are
 * prohibited from initiating a conversation or messaging any TikTok user who
 * has not started a conversation with you." The inverted funnel the research
 * recommends — public reply saying "DM me X", then autoreply — is exactly
 * `publicReply` + `INBOUND_MESSAGE_TRIGGER` + `conversationMessage`, which the
 * compiler already assembles from the capability set. No special case.
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

/** Per authorized account, per Accounts API endpoint. */
export const TT_ACCOUNT_QPM = 40;
/** App-wide across all Accounts endpoints, at the Basic tier. */
export const TT_APP_QPM = 600;

/** Regions where Business Messaging cannot be called at all. */
export const TT_MESSAGING_BLOCKED = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
  "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES",
  "SE", "IS", "LI", "NO", "CH", "GB",
]);

export const tiktokAdapter: PlatformAdapter<"tiktok"> = {
  platform: "tiktok",

  /**
   * business-api.tiktok.com, not developers.tiktok.com — two entirely separate
   * developer platforms, and everything we need is on the business one.
   * Redirect URLs must be https, must END WITH `/`, no query, no port.
   * `&disable_auto_auth=1` or a returning user is silently redirected with no
   * `auth_code`.
   */
  authorizeUrl(_app: ProviderApp, _redirectUri: string, _state: string): string {
    throw new Error("not implemented");
  },

  /**
   * `auth_code` is 10 minutes, single use. The token response returns
   * `open_id`, which becomes `externalId` AND must be passed as `business_id`
   * on every subsequent call. Access token lives 1 day; refresh token 1 year.
   */
  async connect() {
    throw new Error("not implemented");
  },

  /** Daily. On refresh-token expiry the creator must re-authorize — surfaced as an incident. */
  async refresh() {
    throw new Error("not implemented");
  },

  /**
   * Reads the account's registration region and account type, then grants:
   *   always              PUBLIC_REPLY
   *   region not blocked
   *   AND business account
   *   AND messaging scopes granted
   *                       CONVERSATION_MESSAGE, INBOUND_MESSAGE_TRIGGER
   *
   * Declines carry TikTok's own sentence: "The Business Messaging API is not
   * yet available in the European Economic Area, Switzerland or the UK
   * market", and for a personal account, "The Business Messaging API only
   * supports Business Accounts."
   */
  async negotiate(): Promise<AccountCapabilities<"tiktok">> {
    throw new Error("not implemented");
  },

  ingest: {
    verifyChallenge() {
      throw new Error("not implemented");
    },
    verifySignature() {
      throw new Error("not implemented");
    },
    /**
     * `comment.update`, fired within five minutes, for posts published via API
     * AND manually in the app.
     *
     * Two shape traps handled here so nothing downstream sees them:
     *   - `content` is a JSON-ENCODED STRING, not a nested object.
     *   - `parent_comment_id` is present only on replies — that is how a
     *     comment is told from a reply.
     * Only `comment_action === "insert"` becomes a StartTrigger. `text` is in
     * the payload, so keyword matching needs no follow-up read — which matters,
     * because a follow-up read would spend the 40 QPM budget.
     *
     * `im_receive_msg` / `im_receive_msg_eu` -> inboundMessage triggers.
     * `im_receive_high_intent_comment` is NOT parsed: TikTok's classifier, not
     * our keyword, decides those, so treating them as keyword matches would be
     * wrong.
     */
    parse() {
      throw new Error("not implemented");
    },
  } satisfies WebhookIngest,

  /**
   * Reconcile only. ~15 accounts polling once a minute would exhaust the
   * app-wide 600 QPM ceiling, so the base interval is deliberately long and
   * the app-wide bucket's pressure stretches it further.
   *
   * `runSweep` must dedupe by `comment_id` locally and must never treat a
   * short page as end-of-list: beyond 500 comments "the comments beyond the
   * first 500 and the first 500 comments themselves are not deduplicated", and
   * the endpoint "may return less than `max_count` even if `has_more` is true".
   */
  sweep: {
    priority: "safetyNet",
    costPerSweep: 1,
    baseIntervalMs: 30 * 60 * 1000,
    maxIntervalMs: 6 * 60 * 60 * 1000,
    lookbackMs: 48 * 60 * 60 * 1000,
    maxItemsPerSweep: 30,
  } satisfies SweepSpec,

  async runSweep() {
    throw new Error("not implemented");
  },

  async resolveNextPost() {
    throw new Error("not implemented");
  },

  plan(
    _step: AnyStep<"tiktok">,
    _run: unknown,
    _account: ConnectedAccount<"tiktok">
  ): DeliveryPlan<"tiktok"> {
    // TODO: publicReply -> /business/comment/reply/create/, no claim.
    //       conversationMessage / followUp -> messaging, claim
    //       `tt:comment_dm` on the comment id when the conversation was opened
    //       from a comment, because "the comment must not have been replied to
    //       by DM in any way" — the same one-shot shape as Meta's, different
    //       scope string, same ledger.
    throw new Error("not implemented");
  },

  /** Auth header is literally `Access-Token: {token}` — not `Authorization: Bearer`. */
  async deliver(): Promise<DeliveryReceipt> {
    throw new Error("not implemented");
  },

  /**
   *   40100                -> RATE_LIMITED. QPM breach: retry after 5 minutes.
   *                           QPD breach: retry after 00:00 UTC.
   *   token errors         -> TOKEN_INVALID
   *   messaging refusal on
   *   a blocked region     -> INELIGIBLE + incident REGION_INELIGIBLE, which
   *                           also triggers re-negotiation: the account's
   *                           capability set has moved and its campaigns must
   *                           be recompiled.
   */
  classify(_error: unknown): Failure {
    throw new Error("not implemented");
  },

  /**
   * The two-level shape, as a two-element array. Not a special case — the
   * broker reserves across both and compensates if the second refuses.
   *
   *   [ { scope: {kind:"account", ...}, meter:"requests",
   *       window:{kind:"sliding",seconds:60},
   *       capacity:{kind:"fixed",units:TT_ACCOUNT_QPM},
   *       onRefusal:"retryAfter", label:"TikTok per-account QPM" },
   *     { scope: {kind:"providerApp", providerAppId},  meter:"requests",
   *       window:{kind:"sliding",seconds:60},
   *       capacity:{kind:"fixed",units:TT_APP_QPM},
   *       onRefusal:"retryAfter", label:"TikTok app-wide QPM" },
   *     { workspace monthly allowance } ]
   */
  async quotaBuckets(): Promise<readonly BucketSpec[]> {
    throw new Error("not implemented");
  },

  /**
   * The shadow-hide detector. TikTok: "If a comment is flagged as spam, you
   * will not receive the `comment.update` webhook event with `comment_action`
   * set to `set_to_public`." So a reply we posted that never comes back as
   * public is hidden. Raises POLICY_HOLD — the same incident YouTube's
   * `heldForReview` raises.
   */
  async checkDeliveryVisibility() {
    throw new Error("not implemented");
  },

  // probeFollowStatus: absent. No follow signal on TikTok.
};
