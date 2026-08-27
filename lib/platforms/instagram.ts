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
  refreshLongLivedToken,
  getRecentMediaComments,
  sendCommentReply,
  sendDirectMessage as igSendDirectMessage,
  sendDirectMessageWithButton as igSendDirectMessageWithButton,
  sendDirectMessageWithLinkButton,
  sendPrivateReply as igSendPrivateReply,
  sendPrivateReplyWithButton as igSendPrivateReplyWithButton,
  sendPrivateReplyWithLinkButton,
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
  DiscoveredComment,
  Discovery,
  MessagingCapability,
  PlatformAdapter,
  PlatformEvent,
  PostSummary,
  SendResult,
} from "./types";
import { PLATFORM_CAPABILITIES } from "./types";

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

export const instagramAdapter: PlatformAdapter = {
  platform: "INSTAGRAM",
  capabilities: PLATFORM_CAPABILITIES.INSTAGRAM,
  discovery,

  /**
   * 60 days, refreshed by presenting the token itself. There is no separate
   * refresh token to store.
   */
  oauth: {
    authorizeUrl(_app, redirectUri, state) {
      return getAuthorizationUrl(redirectUri, state);
    },
    async exchange(_app, code, redirectUri) {
      const { accessToken } = await exchangeCodeForToken(code, redirectUri);
      const profile = await getUserInfo(accessToken);
      return [
        {
          // `user_id` is the professional account id webhooks arrive under.
          // `id` is app-scoped and matches nothing the messaging API keys off.
          externalId: profile.user_id ?? profile.id,
          username: profile.username,
          displayName: profile.name ?? null,
          accessToken,
          refreshToken: null,
          // Long-lived tokens last 60 days and refresh by presenting themselves.
          expiresInSeconds: 60 * 24 * 3600,
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
    return media.map((m) => ({
      id: m.id,
      caption: m.caption ?? null,
      permalink: m.permalink ?? null,
      thumbnailUrl: m.thumbnail_url ?? m.media_url ?? null,
      videoUrl: m.media_type === "VIDEO" ? (m.media_url ?? null) : null,
      mediaType: m.media_type,
      timestamp: m.timestamp,
      isReel: m.media_product_type === "REELS",
    }));
  },
};