/**
 * Instagram. The reference adapter, and the home of every behaviour the
 * current system already has.
 *
 * ── Where today's Instagram behaviour lives now ─────────────────────────────
 *
 * | today                                    | here                                          |
 * |------------------------------------------|-----------------------------------------------|
 * | one-private-reply-per-comment SKIPPED_DEDUP | `plan()` returns a `ig:private_reply` claim; |
 * |                                          | the engine's `ClaimLedger` enforces it, and   |
 * |                                          | Facebook gets the same rule for free           |
 * | public-reply-first decoupling            | compiler hoists claim-free steps first        |
 * | `publicReplySentAt` idempotency          | `StepOutcome @@unique([runId, stepIndex])`    |
 * | button template -> inline text fallback  | `deliver()`, entirely internal (below)        |
 * | `isTemplateRejection()` regex            | `classify()` -> `Failure.attempted`           |
 * | follow gate fail-open / fail-closed      | `runtime/follow-gate.ts` (pure table)         |
 * | `getUserFollowStatus`                    | `probeFollowStatus` (optional adapter member) |
 * | read-receipt fallback                    | `openingDm.awaits = { signals:["postback",    |
 * |                                          | "read"], timeoutMs: 5min, onTimeout:"continue"}` |
 * | 750/hr limiter + requeue x3              | one `BucketSpec`, `onRefusal:"retryAfter"`    |
 * | polling reconciler                       | `sweep.priority = "safetyNet"`                |
 * | `pendingNextReel` + attach-next-reel cron| `resolveNextPost()`                           |
 * | `entry.id` -> account lookup             | `ConnectedAccount.externalId` (same column)   |
 *
 * Nothing on this list is deleted, generalised away, or reimplemented. The
 * `lib/meta/client.ts` send functions, `lib/utils/keyword-matcher.ts` and
 * `lib/tracking/message.ts` move across as-is; this file is the seam.
 */

import type {
  ConnectedAccount,
  Credential,
  DeliveryPlan,
  DeliveryReceipt,
  Failure,
  FollowStatus,
  PlatformAdapter,
  ProviderApp,
  RenderedContent,
  RunContextForPlan,
  SweepSpec,
  WebhookIngest,
} from "./adapter";
import type { AccountCapabilities, AnyStep } from "./capability";
import type { BucketSpec } from "../runtime/quota";

/** Meta's documented cap for this exact call, unchanged. */
export const IG_PRIVATE_REPLIES_PER_HOUR = 750;
/** Private replies are addressable for 24h from the comment. */
export const IG_PRIVATE_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Read but never tapped -> deliver anyway. Today's constant. */
export const IG_READ_FALLBACK_MS = 5 * 60 * 1000;

/** Opaque to the engine. Only this file constructs or reads it. */
type IgAddressing =
  | { readonly to: "comment"; readonly commentId: string; readonly accountId: string }
  | { readonly to: "conversation"; readonly userId: string; readonly accountId: string }
  | { readonly to: "commentThread"; readonly commentId: string };

export const instagramAdapter: PlatformAdapter<"instagram"> = {
  platform: "instagram",

  // ── Connection ────────────────────────────────────────────────────────────

  /**
   * `www.instagram.com/oauth/authorize` — NOT `api.instagram.com`, which
   * belonged to the retired Basic Display API and now 404s. State stays
   * HMAC-signed with a 10-minute TTL, carrying the workspace id.
   */
  authorizeUrl(_app: ProviderApp, _redirectUri: string, _state: string): string {
    throw new Error("not implemented");
  },

  /**
   * code -> short-lived token -> `getLongLivedToken` (60d) -> `/me` for
   * `user_id` (the professional account id, NOT the app-scoped `id`) ->
   * `subscribeToWebhooks(["comments","messages"])` -> negotiate.
   */
  async connect() {
    throw new Error("not implemented");
  },

  /** 60-day tokens; refresh when within 10 days of expiry, as today. */
  async refresh() {
    throw new Error("not implemented");
  },

  /**
   * Instagram's capability set is static apart from scope grants: if
   * `instagram_business_manage_messages` was not granted, `DIRECT_MESSAGE`,
   * `CONVERSATION_MESSAGE`, `BUTTON_TEMPLATE`, `POSTBACK_SIGNAL`,
   * `READ_SIGNAL` and `INBOUND_MESSAGE_TRIGGER` are all declined with
   * `SCOPE_NOT_GRANTED` — which is exactly the "works for me, not in prod"
   * failure, surfaced in the builder instead of at send time.
   */
  async negotiate(): Promise<AccountCapabilities<"instagram">> {
    throw new Error("not implemented");
  },

  // ── Ingest ────────────────────────────────────────────────────────────────

  ingest: {
    /** `hub.mode=subscribe` + `hub.verify_token` -> echo `hub.challenge`. */
    verifyChallenge() {
      throw new Error("not implemented");
    },
    /**
     * HMAC-SHA256 over the raw body with the INSTAGRAM app secret only.
     * Instagram-Login apps carry a secret distinct from the Meta App Secret,
     * and the route knows which app it is, so there is no secret-guessing.
     */
    verifySignature() {
      throw new Error("not implemented");
    },
    /**
     * `object === "instagram"`. Today's four parsers become one:
     *   changes[].field === "comments"        -> StartTrigger.comment
     *   messaging[].message (not echo/deleted)-> StartTrigger.inboundMessage
     *   messaging[].postback                  -> RunSignal { postback, byRun }
     *   messaging[].read                      -> RunSignal { read, byUser,
     *                                                        speculative: true }
     * Self-comments (`from.id === entry.id`) and echoes are dropped here.
     */
    parse() {
      throw new Error("not implemented");
    },
  } satisfies WebhookIngest,

  /**
   * The reconciler, unchanged in intent: webhooks are best-effort and never
   * fire for collapsed comments or low-signal accounts. Free (no metered
   * quota), so it stays at 5 minutes unless the account's own hourly send
   * budget is under pressure.
   */
  sweep: {
    priority: "safetyNet",
    costPerSweep: 1,
    baseIntervalMs: 5 * 60 * 1000,
    maxIntervalMs: 60 * 60 * 1000,
    lookbackMs: 72 * 60 * 60 * 1000,
    maxItemsPerSweep: 30,
  } satisfies SweepSpec,

  /**
   * Reads the campaign's post (or the last 10 for `anyPost`), asks for
   * `replies{from}`, and skips comments the account has already replied to —
   * so a handled comment is never re-touched. Same narrowing as today.
   */
  async runSweep() {
    throw new Error("not implemented");
  },

  /** Most recent media newer than `since`; drives `TargetSpec.nextPost`. */
  async resolveNextPost() {
    throw new Error("not implemented");
  },

  // ── Execution ─────────────────────────────────────────────────────────────

  /**
   * PURE. Decides addressing, claims and buckets without a network call.
   *
   *   publicReply         -> commentThread; NO claim (a public reply is not
   *                          one-shot); sends bucket
   *   directMessage       -> comment addressing; claim ig:private_reply
   *   linkButtons         -> comment addressing; claim ig:private_reply
   *   openingDm           -> comment addressing; claim ig:private_reply
   *   followGate          -> comment addressing on first contact, conversation
   *                          addressing after a tap; claims only in the first
   *                          case, because after a tap the conversation is
   *                          open and no private reply is consumed
   *   conversationMessage -> conversation; no claim
   *   followUp            -> conversation; no claim
   *
   * The claim on the FIRST private reply and not on subsequent conversation
   * messages is the whole of Meta's one-per-comment rule, expressed as data.
   */
  plan(
    _step: AnyStep<"instagram">,
    _run: RunContextForPlan,
    _account: ConnectedAccount<"instagram">
  ): DeliveryPlan<"instagram"> {
    throw new Error("not implemented");
  },

  /**
   * The single network call on the send path, plus the fallback that must NOT
   * leak to the engine.
   *
   * When `content.buttons` is non-empty, try the button template first
   * (`sendPrivateReplyWithLinkButton` / `sendPrivateReplyWithButton`). On
   * rejection, retry as inline text ONLY when `classify(err).attempted ===
   * "no"` — a closed window or an already-used private reply rejects the text
   * retry the same way and would replace the real error with a misleading one.
   * That is today's `isTemplateRejection()` rule, now derived from the
   * classification rather than from a regex at the call site.
   *
   * The inline fallback appends links 2..3 on their own lines so no link is
   * lost, exactly as `buildInlineLinkFallback` does today.
   */
  async deliver(
    _dp: DeliveryPlan<"instagram">,
    _content: RenderedContent,
    _cred: Credential
  ): Promise<DeliveryReceipt> {
    throw new Error("not implemented");
  },

  /**
   * Meta's error taxonomy, one place.
   *
   *   190                 -> TOKEN_INVALID,      attempted "no",  incident TOKEN_EXPIRED
   *   4 | 17 | 368        -> RATE_LIMITED,       attempted "no",  retryAfter
   *   10 | 100 | 200      -> PERMISSION_DENIED,  attempted "no",  incident PERMISSION_REVOKED
   *   /outside of allowed window/i
   *                       -> WINDOW_CLOSED,      attempted "no"
   *   /invalid for a private reply/i
   *                       -> INELIGIBLE,         attempted "YES" <- load-bearing:
   *                          the comment's one reply is gone whether we sent it
   *                          or someone else did, so the claim must NOT be
   *                          released
   *   /requested user cannot be found/i
   *                       -> INELIGIBLE,         attempted "no"
   *   default             -> RETRYABLE,          attempted "unknown" (keeps
   *                          the claim; over-holding costs one send, wrongly
   *                          releasing costs an unfixable confusing failure)
   */
  classify(_error: unknown): Failure {
    throw new Error("not implemented");
  },

  /** Fixed per-account, plus the workspace's monthly allowance. */
  async quotaBuckets(
    account: ConnectedAccount<"instagram">
  ): Promise<readonly BucketSpec[]> {
    // TODO: return, scarcest first:
    //   { scope:{kind:"account",connectedAccountId:account.id}, meter:"sends",
    //     window:{kind:"sliding",seconds:3600},
    //     capacity:{kind:"fixed",units:IG_PRIVATE_REPLIES_PER_HOUR},
    //     onRefusal:"retryAfter", label:"Instagram hourly private replies" }
    //   { scope:{kind:"workspace",workspaceId:account.workspaceId}, meter:"sends",
    //     window:{kind:"calendarMonth",tz:"UTC"},
    //     capacity:{kind:"fixed",units:planLimit}, onRefusal:"skip",
    //     label:"Monthly plan allowance" }
    throw new Error("not implemented");
  },

  /**
   * `is_user_follow_business`. Present here and NOWHERE else — no other
   * platform exposes it, so no other adapter has this member and a follow gate
   * is both unconstructable (type level) and unexecutable (no probe).
   */
  async probeFollowStatus(): Promise<FollowStatus> {
    throw new Error("not implemented");
  },
};
