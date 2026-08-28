/**
 * What a platform can do, and how the engine asks.
 *
 * Instagram and Facebook share the comment-to-DM mechanic almost exactly, which
 * makes it tempting to treat Facebook as "Instagram with a different host". They
 * differ on three axes the send path must not guess at, and each one is a
 * capability rather than a branch:
 *
 *   The reply window. Instagram allows 24 hours, Facebook 7 days.
 *   The follow gate. Instagram exposes `is_user_follow_business`. Facebook has
 *     no equivalent, so a follow-gated campaign is not runnable there.
 *   Pre-flight eligibility. Facebook answers `can_reply_privately` per comment
 *     before you spend the one reply you get. Instagram makes you find out by
 *     failing.
 *
 * YouTube and TikTok will not have DIRECT_MESSAGE at all. Modelling capability
 * now is what keeps that from becoming a `platform === "youtube"` branch later.
 */

import type { Platform } from "@/app/generated/prisma/client";
import type { ExclusiveClaim } from "@/lib/runtime/claims";

export type { Platform };
export type { ExclusiveClaim };

export type Capability =
  /** Post a public reply under a comment. Every platform has this. */
  | "PUBLIC_REPLY"
  /** Open a private conversation addressed by a comment id. */
  | "PRIVATE_REPLY"
  /** Send inside an already-open conversation. */
  | "CONVERSATION_MESSAGE"
  /** Structured message with tappable buttons. */
  | "BUTTON_TEMPLATE"
  /** Button taps arrive back as routable events. */
  | "POSTBACK_SIGNAL"
  /** Read receipts arrive, enabling the read-but-never-tapped fallback. */
  | "READ_SIGNAL"
  /** Can ask whether a user follows the account. */
  | "FOLLOW_GATE"
  /** Inbound DMs arrive and can start a run. */
  | "INBOUND_MESSAGE_TRIGGER"
  /** Can ask before sending whether a private reply is possible. */
  | "PREFLIGHT_REPLY_ELIGIBILITY"
  /**
   * Can list conversations and read their history, which is the dashboard
   * inbox. Distinct from CONVERSATION_MESSAGE, which only sends: TikTok's
   * conversation list returns a conversation id but not the identifier that
   * attributes it to a commenter, which is what MessagingContact is for.
   */
  | "CONVERSATION_HISTORY";

/**
 * The per-platform ceiling. An account's granted set is always a subset, never
 * a superset.
 */
export const PLATFORM_CAPABILITIES = {
  INSTAGRAM: [
    "PUBLIC_REPLY",
    "PRIVATE_REPLY",
    "CONVERSATION_MESSAGE",
    "BUTTON_TEMPLATE",
    "POSTBACK_SIGNAL",
    "READ_SIGNAL",
    "FOLLOW_GATE",
    "INBOUND_MESSAGE_TRIGGER",
    "CONVERSATION_HISTORY",
  ],
  /**
   * One capability, and not a reduced version of the others.
   *
   * The Data API has no messaging resource at all, and the comment resource
   * exposes only a display name, an avatar URL, and a channel id, so there is no
   * identifier a message could be routed to. There is also no comment webhook,
   * which is why discovery is poll-only.
   */
  YOUTUBE: ["PUBLIC_REPLY"],

  /**
   * Comment read and reply ship globally with no security review. Messaging is
   * absent because TikTok prohibits initiating a conversation with anyone who
   * has not messaged first, and the one carve-out reaches only Business Accounts
   * registered in Vietnam, Indonesia, and Thailand and fires on TikTok's own
   * classifier rather than our keyword.
   */
  TIKTOK: ["PUBLIC_REPLY"],

  FACEBOOK: [
    "PUBLIC_REPLY",
    "PRIVATE_REPLY",
    "CONVERSATION_MESSAGE",
    "BUTTON_TEMPLATE",
    "POSTBACK_SIGNAL",
    "INBOUND_MESSAGE_TRIGGER",
    "PREFLIGHT_REPLY_ELIGIBILITY",
    // The Conversations API, at 2 calls a second per Page. The tightest limit
    // on the platform, and an ordinary bucket rather than a special case.
    "CONVERSATION_HISTORY",
  ],
} as const satisfies Record<Platform, readonly Capability[]>;

export function supports(platform: Platform, capability: Capability): boolean {
  // SAFETY: `satisfies` above proves every entry is a Capability. The widening
  // is only so `includes` accepts the full union rather than one platform's
  // narrower literal tuple.
  const caps = PLATFORM_CAPABILITIES[platform] as readonly Capability[];
  return caps.includes(capability);
}

/**
 * How long after a comment a private reply is still accepted. Meta enforces
 * this; sending late fails rather than queuing.
 *
 * Partial because a platform without PRIVATE_REPLY has no window to state. An
 * entry of 0 would read as a number to callers rather than as an absence.
 */
export const PRIVATE_REPLY_WINDOW_HOURS = {
  INSTAGRAM: 24,
  FACEBOOK: 168,
} satisfies Partial<Record<Platform, number>>;

// ─── Domain events ───────────────────────────────────────────────────────────

/**
 * Wire payloads are parsed into these before they leave an adapter. A Graph API
 * shape never reaches the engine.
 */
export interface CommentEvent {
  kind: "comment";
  platform: Platform;
  accountExternalId: string;
  commentId: string;
  commentText: string;
  commenterId: string;
  commenterName?: string;
  /** The post, reel, or media the comment sits under. */
  postId: string;
  /** Set when the comment is a reply to another comment rather than the post. */
  parentCommentId?: string;
}

export interface MessageEvent {
  kind: "message";
  platform: Platform;
  accountExternalId: string;
  messageId: string;
  messageText: string;
  senderId: string;
}

export interface PostbackEvent {
  kind: "postback";
  platform: Platform;
  accountExternalId: string;
  userId: string;
  payload: string;
  mid?: string;
}

export interface ReadEvent {
  kind: "read";
  platform: Platform;
  accountExternalId: string;
  userId: string;
  watermark?: number;
}

export type PlatformEvent = CommentEvent | MessageEvent | PostbackEvent | ReadEvent;

// ─── Sending ─────────────────────────────────────────────────────────────────

export interface LinkButton {
  title: string;
  url: string;
}

export interface SendResult {
  /** Platform message id, for audit. */
  messageId?: string;
  /**
   * Facebook returns the commenter's page-scoped id only in the private-reply
   * response. It is the only way to address them again, so it is surfaced here
   * rather than discarded.
   */
  discoveredUserId?: string;
}

/**
 * Whether a comment can still take a private reply.
 *
 * `"unknown"` is not a failure. Instagram cannot answer this, and treating its
 * silence as "no" would stop it sending at all.
 */
export type ReplyEligibility = "eligible" | "ineligible" | "unknown";

export interface PostSummary {
  id: string;
  caption: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  /**
   * The playable asset, when this post is a video and the platform exposes one.
   * Null on a still, and on a platform that returns only a thumbnail.
   */
  videoUrl: string | null;
  mediaType: string;
  timestamp: string;
  /** True for Instagram Reels and Facebook Reels. */
  isReel: boolean;
}

/**
 * A comment found by looking, rather than delivered by a webhook.
 *
 * Platform-neutral on purpose. Both sweeps used to read vendor JSON directly,
 * which is why one named Instagram and the other imported a YouTube module, and
 * why Facebook ended up with no safety net at all.
 */
export interface DiscoveredComment {
  id: string;
  postId: string;
  text: string;
  authorId: string;
  authorName: string | null;
  createdAtMs: number | null;
  /**
   * The account owner has already answered this comment on the platform.
   * Null where the listing cannot say, which is not the same as `false`: the
   * caller must fall back to its own ledger rather than assume nobody replied.
   */
  ownerHasReplied: boolean | null;
}

/**
 * How a platform's comments reach us.
 *
 * YouTube has no comment webhook of any kind. WebSub notifies on new videos,
 * title edits, and description edits, and nothing else, so polling is not a
 * safety net there but the only path. Modelling that as a variant rather than a
 * config flag means a poll-only platform has no signature to verify and no
 * payload to parse, so neither method exists to be stubbed.
 */
export type Discovery =
  | {
      readonly kind: "webhook";
      verifySignature(rawBody: string, signature: string | null): boolean;
      parseEvents(payload: unknown): PlatformEvent[];
    }
  | {
      readonly kind: "poll";
      /**
       * Cost of one discovery pass, in whatever unit the platform meters. Used
       * by the scheduler to decide how often it can afford to look.
       */
      readonly pollCost: number;
    };

/** One account the creator authorized, as the adapter resolved it. */
export interface ConnectedIdentity {
  /** The platform's own id, and the key webhooks arrive under. */
  readonly externalId: string;
  readonly username: string;
  readonly displayName: string | null;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresInSeconds: number | null;
  /** ISO country of registration, where the platform reports it. */
  readonly region: string | null;
  /** What the platform actually granted, which may be less than was asked. */
  readonly grantedScopes: readonly string[];
}

/**
 * How a creator connects an account.
 *
 * Every platform has one. Whether it can be used is a different question, and
 * the honest answer to it is whether this instance holds credentials for the
 * platform, which `platformIsConfigured` answers and which changes the moment
 * an operator sets two environment variables. A hardcoded "not yet" would go on
 * saying so after the developer app was approved.
 */
export interface OAuthFlow {
  authorizeUrl(app: ProviderAppRef, redirectUri: string, state: string): string;
  /**
   * One authorization can yield several accounts. A Facebook grant brings every
   * Page the person administers.
   */
  exchange(
    app: ProviderAppRef,
    code: string,
    redirectUri: string
  ): Promise<ConnectedIdentity[]>;
}

/** The credentials an OAuth flow needs, without reaching for the database. */
export interface ProviderAppRef {
  readonly appId: string;
  readonly appSecret: string;
}

export interface RefreshedToken {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  /** Present where the platform rotates the refresh token too. */
  readonly refreshToken?: string;
}

/**
 * How a platform's access token stays valid.
 *
 * A union rather than an optional method, because "never expires" and "refresh
 * it" are different facts and a cron that treats a missing method as either one
 * gets Facebook wrong. Facebook Page tokens derived from a long-lived user
 * token do not expire, so there is nothing to call and nothing to schedule.
 */
export type TokenLifetime =
  | { readonly kind: "permanent" }
  | {
      readonly kind: "refreshable";
      /** Refresh once the token is inside this window of expiring. */
      readonly refreshWithinMs: number;
      /**
       * `refreshToken` is null on platforms that refresh by presenting the
       * access token itself, which is what Instagram does.
       */
      refresh(
        accessToken: string,
        refreshToken: string | null
      ): Promise<RefreshedToken>;
    };

/**
 * Everything a platform can do once it has an open conversation.
 *
 * Absent entirely on platforms with no messaging API. YouTube's Data API has no
 * messaging resource, and the comment resource exposes no identifier a message
 * could be routed to, so there is nothing to send with. TikTok prohibits
 * initiating a conversation outright outside three countries.
 *
 * Grouped rather than made six optional methods so one null check narrows the
 * whole capability, and so a platform cannot half-implement messaging.
 */
export interface MessagingCapability {
  /**
   * Which one-shot resources a private reply to this comment consumes.
   *
   * The core owns the claim mechanism and the adapter owns this policy, which is
   * how Instagram and Facebook get the one-reply-per-comment rule by declaring
   * it rather than by the engine knowing about it.
   */
  claimsForPrivateReply(commentId: string): readonly ExclusiveClaim[];

  sendPrivateReply(
    accessToken: string,
    accountExternalId: string,
    commentId: string,
    message: string
  ): Promise<SendResult>;

  sendPrivateReplyWithButtons(
    accessToken: string,
    accountExternalId: string,
    commentId: string,
    text: string,
    buttons: LinkButton[]
  ): Promise<SendResult>;

  sendDirectMessage(
    accessToken: string,
    accountExternalId: string,
    userId: string,
    message: string
  ): Promise<SendResult>;

  sendDirectMessageWithButtons(
    accessToken: string,
    accountExternalId: string,
    userId: string,
    text: string,
    buttons: LinkButton[]
  ): Promise<SendResult>;

  /**
   * A button whose tap comes back as a postback event rather than opening a
   * URL. This is what makes the opening DM and the follow gate work.
   */
  sendPrivateReplyWithPostback(
    accessToken: string,
    accountExternalId: string,
    commentId: string,
    text: string,
    buttonTitle: string,
    payload: string
  ): Promise<SendResult>;

  sendDirectMessageWithPostback(
    accessToken: string,
    accountExternalId: string,
    userId: string,
    text: string,
    buttonTitle: string,
    payload: string
  ): Promise<SendResult>;

  /** Present only with PREFLIGHT_REPLY_ELIGIBILITY. */
  checkReplyEligibility?(
    accessToken: string,
    commentId: string
  ): Promise<ReplyEligibility>;

  /** Present only with FOLLOW_GATE. */
  checkFollowStatus?(
    accessToken: string,
    accountExternalId: string,
    userId: string
  ): Promise<boolean | null>;
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/**
 * A quantity a platform reports about a post.
 *
 * A closed union, not `Record<string, number>`. Closed is what lets the
 * dashboard sum, sort and compare across accounts; open would make every
 * consumer re-learn each vendor's vocabulary, which is the leak this replaces.
 * A fifth platform either maps onto a member here or adds one, and adding one
 * forces every adapter to consider it.
 */
export type Metric =
  | "VIEWS"
  | "REACH"
  | "LIKES"
  | "COMMENTS"
  | "SAVES"
  | "SHARES";

/**
 * The per-platform ceiling. What an account actually reports is a subset, never
 * a superset, because a token may be granted less than the platform offers.
 */
export const PLATFORM_METRICS = {
  INSTAGRAM: ["VIEWS", "REACH", "LIKES", "COMMENTS", "SAVES", "SHARES"],
  /** A Page has no "saved" equivalent; the rest map onto Page post insights. */
  FACEBOOK: ["VIEWS", "REACH", "LIKES", "COMMENTS", "SHARES"],
  /**
   * The Data API's `statistics` part. There is no reach or saves concept, and
   * `favoriteCount` has been hardcoded to 0 by YouTube for years, so it is not
   * modelled as SAVES.
   */
  YOUTUBE: ["VIEWS", "LIKES", "COMMENTS"],
  TIKTOK: ["VIEWS", "LIKES", "COMMENTS", "SHARES"],
} as const satisfies Record<Platform, readonly Metric[]>;

/**
 * One number, with everything needed to render it without knowing where it came
 * from.
 *
 * `label` is what this platform calls the metric to its own users: a Page says
 * "People reached" where Instagram says "Reach". Only the adapter knows the
 * vendor's vocabulary, so only the adapter can supply it.
 *
 * `value: null` means the platform reports this metric but the current token
 * cannot read it, which reconnecting fixes. A metric absent from the list
 * entirely means the platform does not have it, which never will. The UI has to
 * say different things, so the type distinguishes them.
 */
export interface ReportedMetric {
  readonly metric: Metric;
  readonly label: string;
  readonly value: number | null;
  /** Display order. Lower sorts first, so each platform leads with its headline. */
  readonly rank: number;
}

/**
 * What one post scored, by metric.
 *
 * Partial because a platform reports a subset and a token may be granted less
 * again. An absent key means "not reported"; it is never a zero, because a post
 * with no reach data and a post with zero reach are different facts.
 */
export type MetricValues = Partial<Record<Metric, number>>;

export interface AudiencePoint {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly value: number;
  /** Change against the previous point, or null for the first one. */
  readonly delta: number | null;
}

/**
 * Why part of a report is missing, phrased for the person reading it.
 *
 * Carried in the report rather than thrown, because a missing insights scope
 * must not cost the caller the likes and comments that did arrive.
 */
export interface ReportNotice {
  readonly kind: "permission" | "truncated";
  readonly message: string;
}

/**
 * What one account's analytics look like, fully described by the adapter.
 *
 * The alternative — handing back a bare `Partial<Record<Metric, number>>` —
 * leaves tile order, per-vendor labels and empty-state policy to be re-decided
 * in every page that renders it. That policy belongs to the adapter that knows
 * the platform.
 */
export interface AccountReport {
  readonly tiles: readonly ReportedMetric[];
  /** Columns for the per-post table, in display order. */
  readonly columns: readonly { readonly metric: Metric; readonly label: string }[];
  readonly rows: readonly {
    readonly post: PostSummary;
    readonly values: MetricValues;
  }[];
  readonly notices: readonly ReportNotice[];
}

/**
 * How many people follow an account.
 *
 * Followers, fans, or subscribers: one concept with four names, which is why
 * the noun travels with the number. Deliberately not part of `AccountReport`.
 * The combined figure across every connected account has to ask each one, and
 * building a full post-by-post report per account to reach a single number
 * would cost hundreds of requests for one line of UI.
 */
export interface Audience {
  readonly noun: string;
  readonly current: number | null;
  readonly history: readonly AudiencePoint[];
}

/**
 * Reading numbers back out of a platform.
 *
 * Null on `PlatformAdapter` where the platform has no analytics surface at all.
 * A nullable field rather than optional methods, so one check narrows the whole
 * capability and a platform cannot half-implement it.
 */
export interface InsightsCapability {
  readonly metrics: readonly Metric[];
  /**
   * One call for the whole Overview.
   *
   * The adapter owns its own fan-out, pagination and degradation. Instagram's
   * implementation is a per-media insight request per post under bounded
   * concurrency, which is the single largest subrequest consumer in the app —
   * keeping it behind this method is what lets that budget be reasoned about in
   * one place rather than per route.
   */
  buildReport(
    accessToken: string,
    accountExternalId: string,
    options: { readonly limit: number }
  ): Promise<AccountReport>;

  /**
   * One cheap call, so the cross-platform total can ask every account without
   * building every report. Null where the platform reports no audience size, or
   * where the account has hidden it — which is an absence, never a zero.
   */
  fetchAudience(
    accessToken: string,
    accountExternalId: string
  ): Promise<Audience | null>;
}

/** One conversation, as the dashboard inbox lists it. */
export interface Thread {
  readonly id: string;
  readonly contact: { readonly id: string; readonly username: string | null };
  readonly updatedAt: string | null;
  readonly lastMessage: {
    readonly text: string;
    readonly fromMe: boolean;
    readonly at: string | null;
  } | null;
}

export interface ThreadMessage {
  readonly id: string;
  readonly text: string;
  readonly fromMe: boolean;
  readonly fromUsername: string | null;
  readonly at: string | null;
}

/**
 * Reading conversation history, which is a different question from sending.
 *
 * `CONVERSATION_HISTORY` has been in the capability table since the capability
 * layer was written, with nothing behind it on Facebook. The inbox filtered on
 * the table, offered a Page, and then failed against an Instagram-only client.
 * Deriving availability from `adapter.conversations !== null` makes the claim
 * and the implementation the same fact.
 */
export interface ConversationsCapability {
  listThreads(
    accessToken: string,
    accountExternalId: string,
    limit: number
  ): Promise<readonly Thread[]>;

  readThread(
    accessToken: string,
    accountExternalId: string,
    threadId: string
  ): Promise<readonly ThreadMessage[]>;

  /**
   * Replying from the dashboard. Null where history is readable but the reply
   * would have to originate from us, which TikTok prohibits outside three
   * countries.
   */
  readonly reply:
    | ((
        accessToken: string,
        accountExternalId: string,
        recipientId: string,
        text: string
      ) => Promise<SendResult>)
    | null;
}

/**
 * One network.
 *
 * The public comment reply is the only universal capability, so it is the only
 * send method here. Everything else a platform might do hangs off a field that
 * can be absent, which is what stops a platform declining a capability from
 * having to stub it.
 */
export interface PlatformAdapter {
  readonly platform: Platform;
  readonly capabilities: readonly Capability[];

  readonly discovery: Discovery;

  readonly tokens: TokenLifetime;

  readonly oauth: OAuthFlow;

  /** Null where the platform has no messaging API at all. */
  readonly messaging: MessagingCapability | null;

  /** Null where the platform reports no post-level analytics. */
  readonly insights: InsightsCapability | null;

  /**
   * The account's own avatar, for the campaign preview that shows a creator
   * what their DM will look like arriving.
   *
   * Optional rather than nullable: a platform that does not expose one has
   * nothing to implement, and the preview simply falls back to initials.
   */
  fetchProfileImage?(accessToken: string, accountExternalId: string): Promise<string | null>;

  /**
   * Ask the platform to start delivering this account's events to us.
   *
   * Absent on a platform where there is nothing to subscribe: YouTube is
   * poll-only, and TikTok's webhook is registered once for the app rather than
   * per account. Optional rather than nullable so neither has to stub it.
   *
   * Meta unsubscribes an app after an hour of delivery failures, so this is not
   * only a connect-time step; a Page or account that stops delivering has to be
   * re-subscribed rather than debugged in the dashboard.
   */
  subscribeToEvents?(accessToken: string, accountExternalId: string): Promise<boolean>;

  /** Null where conversation history cannot be read. */
  readonly conversations: ConversationsCapability | null;

  /**
   * `accountExternalId` is not decoration. TikTok requires the account's own
   * `business_id` on every Business API call, and it used to come from a single
   * global environment variable, which is wrong the moment a second creator
   * connects.
   */
  postPublicReply(
    accessToken: string,
    accountExternalId: string,
    commentId: string,
    message: string
  ): Promise<{ id: string }>;

  listPosts(
    accessToken: string,
    accountExternalId: string,
    limit: number
  ): Promise<PostSummary[]>;

  /**
   * Recent comments, for whichever sweep runs on this platform.
   *
   * An empty `postIds` means every post on the account. YouTube answers that in
   * one metered call across the whole channel, so narrowing to a post would cost
   * more rather than less; Instagram and Facebook have no channel-wide edge and
   * return nothing without one.
   */
  listRecentComments(
    accessToken: string,
    accountExternalId: string,
    options: { readonly postIds: readonly string[]; readonly sinceMs: number }
  ): Promise<DiscoveredComment[]>;
}
