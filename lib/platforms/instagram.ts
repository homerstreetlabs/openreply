/**
 * Instagram, wrapping the client that already works.
 *
 * This adapter deliberately adds no behaviour. Everything it calls is the code
 * that is in production today, so adopting the adapter interface cannot change
 * how Instagram sends. Facebook is the platform that had to be written; this one
 * only had to be described.
 */

import {
  getUserFollowStatus,
  getUserInfo,
  getAllUserMedia,
  getLongLivedToken,
  getMediaInsights,
  getConversations,
  getConversationMessages,
  PermissionError,
  refreshLongLivedToken,
  getRecentMediaComments,
  sendCommentReply,
  type InstagramMedia,
  sendDirectMessage as igSendDirectMessage,
  sendDirectMessageWithButton as igSendDirectMessageWithButton,
  sendDirectMessageWithLinkButton,
  sendPrivateReply as igSendPrivateReply,
  sendPrivateReplyWithButton as igSendPrivateReplyWithButton,
  sendPrivateReplyWithLinkButton,
  subscribeInstagramAccountToWebhooks,
} from "@/lib/meta/client";
import {
  INSTAGRAM_SCOPES,
  exchangeCodeForToken,
  getAuthorizationUrl,
} from "@/lib/meta/oauth";
import {
  parseCommentEvents,
  parseMessageEvents,
  parsePostbackEvents,
  parseReadEvents,
  verifyWebhookSignature,
} from "@/lib/meta/webhook";
import type {
  ConversationsCapability,
  DiscoveredComment,
  Discovery,
  InsightsCapability,
  MessagingCapability,
  Metric,
  MetricValues,
  PlatformAdapter,
  PlatformEvent,
  PostSummary,
  ReportNotice,
  SendResult,
} from "./types";
import { PLATFORM_CAPABILITIES, PLATFORM_METRICS } from "./types";
import { mapWithConcurrency } from "./concurrency";

/**
 * How many per-media insight requests are in flight at once. Eight keeps a
 * 500-post report inside a Worker's subrequest concurrency without serialising
 * it into a timeout.
 */
const INSIGHTS_CONCURRENCY = 8;

type WebhookPayload = Parameters<typeof parseCommentEvents>[0];

const discovery: Discovery = {
  kind: "webhook",

  verifySignature(rawBody, signature) {
    return verifyWebhookSignature(rawBody, signature);
  },

  parseEvents(payload: unknown): PlatformEvent[] {
    // SAFETY: each parse function below re-checks `object === "instagram"` and
    // skips entries missing required ids, so a mismatched payload yields no
    // events rather than bad ones.
    const body = payload as WebhookPayload;
    const events: PlatformEvent[] = [];

    for (const c of parseCommentEvents(body)) {
      events.push({
        kind: "comment",
        platform: "INSTAGRAM",
        accountExternalId: c.instagramAccountId,
        commentId: c.commentId,
        commentText: c.commentText,
        commenterId: c.commenterId,
        commenterName: c.commenterName,
        postId: c.mediaId,
      });
    }
    for (const m of parseMessageEvents(body)) {
      events.push({
        kind: "message",
        platform: "INSTAGRAM",
        accountExternalId: m.instagramAccountId,
        messageId: m.messageId,
        messageText: m.messageText,
        senderId: m.senderId,
      });
    }
    for (const p of parsePostbackEvents(body)) {
      events.push({
        kind: "postback",
        platform: "INSTAGRAM",
        accountExternalId: p.instagramAccountId,
        userId: p.userId,
        payload: p.payload,
        mid: p.mid,
      });
    }
    for (const r of parseReadEvents(body)) {
      events.push({
        kind: "read",
        platform: "INSTAGRAM",
        accountExternalId: r.instagramAccountId,
        userId: r.userId,
        watermark: r.watermark,
      });
    }
    return events;
  },
};

const messaging: MessagingCapability = {
  claimsForPrivateReply(commentId) {
    return [
      {
        scope: "ig:private_reply",
        key: commentId,
      },
    ];
  },

  async sendPrivateReply(accessToken, accountId, commentId, message): Promise<SendResult> {
    const r = await igSendPrivateReply(accessToken, accountId, commentId, message);
    return { messageId: r.message_id, discoveredUserId: r.recipient_id };
  },

  async sendPrivateReplyWithButtons(
    accessToken,
    accountId,
    commentId,
    text,
    buttons
  ): Promise<SendResult> {
    const r = await sendPrivateReplyWithLinkButton(
      accessToken,
      accountId,
      commentId,
      text,
      buttons
    );
    return { messageId: r.message_id, discoveredUserId: r.recipient_id };
  },

  async sendDirectMessage(accessToken, accountId, userId, message): Promise<SendResult> {
    const r = await igSendDirectMessage(accessToken, accountId, userId, message);
    return { messageId: r.message_id, discoveredUserId: r.recipient_id };
  },

  async sendDirectMessageWithButtons(
    accessToken,
    accountId,
    userId,
    text,
    buttons
  ): Promise<SendResult> {
    const r = await sendDirectMessageWithLinkButton(
      accessToken,
      accountId,
      userId,
      text,
      buttons
    );
    return { messageId: r.message_id, discoveredUserId: r.recipient_id };
  },

  async sendPrivateReplyWithPostback(
    accessToken,
    accountId,
    commentId,
    text,
    buttonTitle,
    payload
  ): Promise<SendResult> {
    const r = await igSendPrivateReplyWithButton(
      accessToken,
      accountId,
      commentId,
      text,
      buttonTitle,
      payload
    );
    return { messageId: r.message_id, discoveredUserId: r.recipient_id };
  },

  async sendDirectMessageWithPostback(
    accessToken,
    accountId,
    userId,
    text,
    buttonTitle,
    payload
  ): Promise<SendResult> {
    const r = await igSendDirectMessageWithButton(
      accessToken,
      accountId,
      userId,
      text,
      buttonTitle,
      payload
    );
    return { messageId: r.message_id, discoveredUserId: r.recipient_id };
  },

  async checkFollowStatus(accessToken, _accountId, userId) {
    return getUserFollowStatus(accessToken, userId);
  },
};

function toPostSummary(media: InstagramMedia): PostSummary {
  return {
    id: media.id,
    caption: media.caption ?? null,
    permalink: media.permalink ?? null,
    thumbnailUrl: media.thumbnail_url ?? media.media_url ?? null,
    videoUrl: media.media_type === "VIDEO" ? (media.media_url ?? null) : null,
    mediaType: media.media_product_type ?? media.media_type,
    timestamp: media.timestamp,
    isReel: media.media_product_type === "REELS",
  };
}

/**
 * Views only exist on video-like media. Asking for them on a still returns an
 * error for the whole request rather than a partial result, which would cost
 * the reach and saves that were valid.
 */
function metricsFor(media: InstagramMedia): string[] {
  const video =
    media.media_product_type === "REELS" || media.media_type === "VIDEO";
  return video
    ? ["views", "reach", "saved", "shares"]
    : ["reach", "saved", "shares"];
}

const INSIGHT_LABELS = {
  VIEWS: "Views",
  REACH: "Reach",
  LIKES: "Likes",
  COMMENTS: "Comments",
  SAVES: "Saved",
  SHARES: "Shares",
} satisfies Record<Metric, string>;

/** Headline first. Reach leads on Instagram; likes and comments are table stakes. */
const INSIGHT_RANK = {
  VIEWS: 1,
  REACH: 2,
  LIKES: 3,
  COMMENTS: 4,
  SAVES: 5,
  SHARES: 6,
} satisfies Record<Metric, number>;

const insights: InsightsCapability = {
  metrics: PLATFORM_METRICS.INSTAGRAM,

  async buildReport(accessToken, accountExternalId, { limit }) {
    const media = await getAllUserMedia(accessToken, limit);

    // Likes and comments ride along with the media fields and are always
    // present. Everything else needs the insights permission, so a token
    // granted before that scope degrades to the two rather than to nothing.
    let permissionDenied = false;
    const perMedia = await mapWithConcurrency(media, INSIGHTS_CONCURRENCY, async (m) => {
      try {
        return await getMediaInsights(accessToken, m.id, metricsFor(m));
      } catch (error) {
        if (error instanceof PermissionError) permissionDenied = true;
        return null;
      }
    });

    const granted: Metric[] = permissionDenied
      ? ["LIKES", "COMMENTS"]
      : [...PLATFORM_METRICS.INSTAGRAM];

    const rows = media.map((m, i) => {
      const ins = perMedia[i];
      const values: MetricValues = {
        LIKES: m.like_count ?? 0,
        COMMENTS: m.comments_count ?? 0,
      };
      if (ins) {
        if (ins.views !== undefined) values.VIEWS = ins.views;
        if (ins.reach !== undefined) values.REACH = ins.reach;
        if (ins.saved !== undefined) values.SAVES = ins.saved;
        if (ins.shares !== undefined) values.SHARES = ins.shares;
      }
      return {
        post: toPostSummary(m),
        values,
      };
    });

    const notices: ReportNotice[] = [];
    if (permissionDenied) {
      notices.push({
        kind: "permission",
        message:
          "Views, reach, saved and shares need the insights permission. Reconnect this account to grant it.",
      });
    }
    if (media.length >= limit) {
      notices.push({
        kind: "truncated",
        message: `Showing the most recent ${limit} posts.`,
      });
    }

    return {
      tiles: granted.map((metric) => ({
        metric,
        label: INSIGHT_LABELS[metric],
        value: rows.reduce<number | null>(
          (sum, row) => (row.values[metric] === undefined ? sum : (sum ?? 0) + row.values[metric]),
          null
        ),
        rank: INSIGHT_RANK[metric],
      })),
      columns: granted.map((metric) => ({ metric, label: INSIGHT_LABELS[metric] })),
      rows,
      notices,
    };
  },

  /**
   * Instagram's account insights expose follower deltas rather than a running
   * total, so the series is reconstructed from snapshots we already record.
   */
  async fetchAudience(accessToken, accountExternalId) {
    const profile = await getUserInfo(accessToken);
    const current = profile.followers_count ?? null;
    return { noun: "followers", current, history: [] };
  },
};

const conversations: ConversationsCapability = {
  async listThreads(accessToken, accountExternalId, limit) {
    const raw = await getConversations(accessToken, accountExternalId, limit);
    return raw.map((c) => {
      const participants = c.participants?.data ?? [];
      const contact =
        participants.find((p) => p.id !== accountExternalId) ?? participants[0] ?? null;
      const last = c.messages?.data?.[0] ?? null;
      return {
        id: c.id,
        contact: { id: contact?.id ?? "", username: contact?.username ?? null },
        updatedAt: c.updated_time ?? null,
        lastMessage: last
          ? {
              text: last.message ?? "",
              fromMe: last.from?.id === accountExternalId,
              at: last.created_time ?? null,
            }
          : null,
      };
    });
  },

  async readThread(accessToken, accountExternalId, threadId) {
    const raw = await getConversationMessages(accessToken, threadId);
    return raw.map((m) => ({
      id: m.id,
      text: m.message ?? "",
      fromMe: m.from?.id === accountExternalId,
      fromUsername: m.from?.username ?? null,
      at: m.created_time ?? null,
    }));
  },

  async reply(accessToken, accountExternalId, recipientId, text) {
    const result = await igSendDirectMessage(accessToken, accountExternalId, recipientId, text);
    return { messageId: result.message_id };
  },
};

export const instagramAdapter: PlatformAdapter = {
  platform: "INSTAGRAM",
  capabilities: PLATFORM_CAPABILITIES.INSTAGRAM,
  discovery,
  insights,
  conversations,

  async subscribeToEvents(accessToken, accountExternalId) {
    const result = await subscribeInstagramAccountToWebhooks(
      accountExternalId,
      accessToken
    );
    return Boolean(result.success);
  },

  async fetchProfileImage(accessToken) {
    const info = await getUserInfo(accessToken);
    return info.profile_picture_url ?? null;
  },

  /**
   * 60 days, refreshed by presenting the token itself. There is no separate
   * refresh token to store.
   */
  oauth: {
    authorizeUrl(_app, redirectUri, state) {
      return getAuthorizationUrl(redirectUri, state);
    },
    async exchange(_app, code, redirectUri) {
      // The authorization-code grant returns a SHORT-lived token, good for about
      // an hour. `ig_exchange_token` is what turns it into the 60-day one, and
      // skipping it stored a token that died overnight while the row recorded
      // 60 days remaining — so the refresh cron, which only looks at accounts
      // inside 10 days of expiry, never came back for it.
      const { accessToken: shortLived } = await exchangeCodeForToken(code, redirectUri);
      const longLived = await getLongLivedToken(shortLived);

      const profile = await getUserInfo(longLived.accessToken);
      return [
        {
          // `user_id` is the professional account id webhooks arrive under.
          // `id` is app-scoped and matches nothing the messaging API keys off.
          externalId: profile.user_id ?? profile.id,
          username: profile.username,
          displayName: profile.name ?? null,
          accessToken: longLived.accessToken,
          refreshToken: null,
          // Meta's own number. Asserting 60 days here is what made the stored
          // expiry a claim rather than a fact.
          expiresInSeconds: longLived.expiresIn,
          region: null,
          grantedScopes: INSTAGRAM_SCOPES,
        },
      ];
    },
  } as const,

  tokens: {
    kind: "refreshable",
    refreshWithinMs: 10 * 24 * 3_600_000,
    async refresh(accessToken) {
      const refreshed = await refreshLongLivedToken(accessToken);
      return { accessToken: refreshed.accessToken, expiresInSeconds: refreshed.expiresIn };
    },
  } as const,
  messaging,

  async postPublicReply(accessToken, accountExternalId, commentId, message) {
    return sendCommentReply(accessToken, commentId, message);
  },

  async listRecentComments(accessToken, accountExternalId, { postIds, sinceMs }) {
    const found: DiscoveredComment[] = [];
    for (const postId of postIds) {
      const comments = await getRecentMediaComments(accessToken, postId, sinceMs);
      for (const c of comments) {
        const authorId = c.from?.id;
        if (!authorId) continue;
        found.push({
          id: c.id,
          postId,
          text: c.text ?? "",
          authorId,
          authorName: c.from?.username ?? null,
          createdAtMs: Date.parse(c.timestamp) || null,
          ownerHasReplied: (c.replies?.data ?? []).some(
            (r) => r.from?.id === accountExternalId
          ),
        });
      }
    }
    return found;
  },

  async listPosts(accessToken, _accountId, limit): Promise<PostSummary[]> {
    const media = await getAllUserMedia(accessToken, limit);
    return media.map(toPostSummary);
  },
};