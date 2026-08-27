/**
 * Facebook Pages, including Reels.
 *
 * Endpoints and limits verified against Meta documentation on 2026-08-24. See
 * docs/setup.md#facebook-setup for the app configuration this depends on and the
 * evidence behind each constraint.
 *
 * Two things here are inference rather than documented contract, and both are
 * marked at the point they matter. Meta publishes no sample payload for a
 * comment on a Reel, and `GET /{page-id}/video_reels` is documented in a guide
 * while the API reference says reading it is unsupported.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { getMetaGraphApiVersion } from "@/lib/env";
import type {
  DiscoveredComment,
  CommentEvent,
  Discovery,
  LinkButton,
  MessageEvent,
  MessagingCapability,
  PlatformAdapter,
  PlatformEvent,
  PostSummary,
  PostbackEvent,
  ReplyEligibility,
  SendResult,
} from "./types";
import { PLATFORM_CAPABILITIES } from "./types";
import {
  FACEBOOK_SCOPES,
  canOperatePage,
  exchangeCodeForPages,
  getFacebookAuthorizationUrl,
} from "./facebook-oauth";

function graphBase() {
  return `https://graph.facebook.com/${getMetaGraphApiVersion()}`;
}

interface GraphError {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; fbtrace_id?: string };
}

async function handle<T>(response: Response): Promise<T> {
  // SAFETY: the Graph API returns either the requested shape or an `error`
  // object. The branch below throws on the error case, so only callers of a
  // successful response observe T.
  const data = (await response.json()) as T & GraphError;
  if (!response.ok || data.error) {
    const err = data.error;
    let path = "";
    try {
      path = ` (${new URL(response.url).pathname})`;
    } catch {}
    throw new Error(
      `${err?.message ?? "Unknown Facebook API error"}${path} [code=${err?.code ?? response.status} sub=${err?.error_subcode ?? "-"} trace=${err?.fbtrace_id ?? "-"}]`
    );
  }
  return data;
}

interface PageFeedValue {
  item?: string;
  verb?: string;
  comment_id?: string;
  post_id?: string;
  parent_id?: string;
  message?: string;
  is_hidden?: boolean;
  from?: { id?: string; name?: string };
}

interface PageEntry {
  id?: string;
  time?: number;
  changes?: Array<{ field?: string; value?: PageFeedValue }>;
  messaging?: Array<{
    sender?: { id?: string };
    recipient?: { id?: string };
    postback?: { mid?: string; payload?: string };
    message?: { mid?: string; text?: string; is_echo?: boolean; is_deleted?: boolean };
  }>;
}

interface PagePayload {
  object?: string;
  entry?: PageEntry[];
}

const discovery: Discovery = {
  kind: "webhook",

  verifySignature(rawBody: string, signature: string | null): boolean {
    if (!signature) return false;
    const secret = process.env.FACEBOOK_APP_SECRET;
    if (!secret) {
      throw new Error("FACEBOOK_APP_SECRET is required to verify Page webhooks");
    }
    const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  },

  parseEvents(payload: unknown): PlatformEvent[] {
    // SAFETY: every field on PagePayload is optional, and the `object` check on
    // the next line rejects anything that is not a Page webhook. Signature
    // verification has already run before this is reached.
    const body = payload as PagePayload;
    if (body?.object !== "page") return [];

    const events: PlatformEvent[] = [];

    for (const entry of body.entry ?? []) {
      const pageId = entry.id;
      if (!pageId) continue;

      for (const change of entry.changes ?? []) {
        if (change.field !== "feed") continue;
        const value = change.value;
        if (!value) continue;

        // Meta publishes no sample payload for a comment on a Reel, and `reels`
        // is absent from the documented `item` enum. A reel is a Page post, so a
        // reel comment is expected to arrive as an ordinary `comment`. Keying on
        // comment_id and ignoring media type means it works either way, and an
        // unexpected item value is logged rather than silently dropped.
        if (value.item !== "comment") {
          if (value.item && value.comment_id) {
            console.warn(
              `[facebook] comment-bearing event with unrecognised item "${value.item}"; ` +
                `treating as a comment. Payload keys: ${Object.keys(value).join(",")}`
            );
          } else {
            continue;
          }
        }

        if (value.verb !== "add") continue;
        if (value.is_hidden === true) continue;

        const commentId = value.comment_id;
        const commenterId = value.from?.id;
        if (!commentId || !commenterId) continue;

        // The Page commenting on its own post echoes back. Replying to that
        // would be the account DMing itself, which Meta rejects anyway.
        if (commenterId === pageId) continue;

        const comment: CommentEvent = {
          kind: "comment",
          platform: "FACEBOOK",
          accountExternalId: pageId,
          commentId,
          commentText: value.message ?? "",
          commenterId,
          commenterName: value.from?.name,
          postId: value.post_id ?? "",
        };
        if (value.parent_id && value.parent_id !== value.post_id) {
          comment.parentCommentId = value.parent_id;
        }
        events.push(comment);
      }

      for (const messaging of entry.messaging ?? []) {
        const senderId = messaging.sender?.id;
        const accountId = pageId ?? messaging.recipient?.id;
        if (!senderId || !accountId || senderId === accountId) continue;

        const postbackPayload = messaging.postback?.payload;
        if (postbackPayload) {
          const postback: PostbackEvent = {
            kind: "postback",
            platform: "FACEBOOK",
            accountExternalId: accountId,
            userId: senderId,
            payload: postbackPayload,
            mid: messaging.postback?.mid,
          };
          events.push(postback);
          continue;
        }

        const message = messaging.message;
        if (!message || message.is_echo || message.is_deleted) continue;
        const text = message.text?.trim();
        if (!text || !message.mid) continue;

        const inbound: MessageEvent = {
          kind: "message",
          platform: "FACEBOOK",
          accountExternalId: accountId,
          messageId: message.mid,
          messageText: text,
          senderId,
        };
        events.push(inbound);
      }
    }

    return events;
  },
};

const messaging: MessagingCapability = {
  claimsForPrivateReply(commentId) {
    return [
      {
        scope: "fb:private_reply",
        key: commentId,
      },
    ];
  },

  async sendPrivateReply(accessToken, pageId, commentId, message): Promise<SendResult> {
    return sendToPage(accessToken, pageId, {
      recipient: { comment_id: commentId },
      message: { text: message },
    });
  },

  async sendPrivateReplyWithButtons(
    accessToken,
    pageId,
    commentId,
    text,
    buttons
  ): Promise<SendResult> {
    return sendToPage(accessToken, pageId, {
      recipient: { comment_id: commentId },
      message: buttonTemplate(text, buttons),
    });
  },

  async sendDirectMessage(accessToken, pageId, userId, message): Promise<SendResult> {
    return sendToPage(accessToken, pageId, {
      recipient: { id: userId },
      message: { text: message },
    });
  },

  async sendDirectMessageWithButtons(
    accessToken,
    pageId,
    userId,
    text,
    buttons
  ): Promise<SendResult> {
    return sendToPage(accessToken, pageId, {
      recipient: { id: userId },
      message: buttonTemplate(text, buttons),
    });
  },

  async sendPrivateReplyWithPostback(
    accessToken,
    pageId,
    commentId,
    text,
    buttonTitle,
    payload
  ): Promise<SendResult> {
    return sendToPage(accessToken, pageId, {
      recipient: { comment_id: commentId },
      message: postbackTemplate(text, buttonTitle, payload),
    });
  },

  async sendDirectMessageWithPostback(
    accessToken,
    pageId,
    userId,
    text,
    buttonTitle,
    payload
  ): Promise<SendResult> {
    return sendToPage(accessToken, pageId, {
      recipient: { id: userId },
      message: postbackTemplate(text, buttonTitle, payload),
    });
  },

  /**
   * Facebook answers this per comment, which Instagram cannot. Checking first
   * matters because a comment accepts exactly one private reply ever, so a send
   * that was never going to work still burns it.
   */
  async checkReplyEligibility(accessToken, commentId): Promise<ReplyEligibility> {
    const url = new URL(`${graphBase()}/${commentId}`);
    url.searchParams.set("fields", "can_reply_privately");
    url.searchParams.set("access_token", accessToken);

    try {
      const response = await fetch(url.toString());
      if (!response.ok) return "unknown";
      // SAFETY: optional field, and the typeof check below is what decides.
      const data = (await response.json()) as { can_reply_privately?: boolean };
      if (typeof data.can_reply_privately !== "boolean") return "unknown";
      return data.can_reply_privately ? "eligible" : "ineligible";
    } catch {
      return "unknown";
    }
  },
};

export const facebookAdapter: PlatformAdapter = {
  platform: "FACEBOOK",
  capabilities: PLATFORM_CAPABILITIES.FACEBOOK,
  discovery,

  /**
   * Page tokens derived from a long-lived user token do not expire. Nothing to
   * refresh, and nothing for the cron to schedule.
   */
  oauth: {
    authorizeUrl(_app, redirectUri, state) {
      return getFacebookAuthorizationUrl(redirectUri, state);
    },
    async exchange(_app, code, redirectUri) {
      const pages = await exchangeCodeForPages(code, redirectUri);
      // One grant brings every Page the person administers, and a Page they
      // cannot message is not a Page this can act on.
      return pages.filter(canOperatePage).map((page) => ({
        externalId: page.id,
        username: page.name,
        displayName: page.name,
        accessToken: page.accessToken,
        refreshToken: null,
        // Page tokens derived from a long-lived user token do not expire.
        expiresInSeconds: null,
        region: null,
        grantedScopes: FACEBOOK_SCOPES,
      }));
    },
  } as const,

  tokens: { kind: "permanent" } as const,
  messaging,

  async postPublicReply(accessToken, accountExternalId, commentId, message) {
    const response = await fetch(`${graphBase()}/${commentId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, access_token: accessToken }),
    });
    return handle<{ id: string }>(response);
  },

  /**
   * Reels are excluded from `/feed` and `/posts`, which say so explicitly and
   * point here instead. The Graph API reference for this edge claims reading is
   * unsupported while the Reels publishing guide documents it, so a failure here
   * is reported as empty rather than fatal and the caller falls back to
   * `/{page-id}/posts` for non-reel content.
   */
  /**
   * ⚠️ Unverified against a live Page. The `feed` webhook is Facebook's primary
   * path and this is only the safety net for when Meta drops a delivery, so it
   * reads the documented `/{post-id}/comments` edge rather than inventing one.
   * `from` on a comment needs `pages_read_engagement`, which the connect flow
   * already requests.
   */
  async listRecentComments(accessToken, accountExternalId, { postIds, sinceMs }) {
    const found: DiscoveredComment[] = [];

    for (const postId of postIds) {
      const url = new URL(`${graphBase()}/${postId}/comments`);
      url.searchParams.set("fields", "id,message,created_time,from,comments{from}");
      url.searchParams.set("order", "reverse_chronological");
      url.searchParams.set("limit", "50");
      url.searchParams.set("access_token", accessToken);

      const response = await fetch(url.toString());
      // SAFETY: every field is optional and each is re-checked below, so a
      // payload of another shape yields no comments rather than bad ones.
      const body = (await response.json()) as {
        data?: Array<{
          id?: string;
          message?: string;
          created_time?: string;
          from?: { id?: string; name?: string };
          comments?: { data?: Array<{ from?: { id?: string } }> };
        }>;
        error?: { message?: string };
      };
      if (!response.ok || body.error) {
        throw new Error(
          `Facebook API error: ${body.error?.message ?? response.statusText}`
        );
      }

      for (const c of body.data ?? []) {
        const authorId = c.from?.id;
        if (!c.id || !authorId) continue;
        const createdAtMs = c.created_time ? Date.parse(c.created_time) || null : null;
        if (createdAtMs !== null && createdAtMs < sinceMs) continue;
        found.push({
          id: c.id,
          postId,
          text: c.message ?? "",
          authorId,
          authorName: c.from?.name ?? null,
          createdAtMs,
          ownerHasReplied: (c.comments?.data ?? []).some(
            (r) => r.from?.id === accountExternalId
          ),
        });
      }
    }

    return found;
  },

  async listPosts(accessToken, pageId, limit): Promise<PostSummary[]> {
    const url = new URL(`${graphBase()}/${pageId}/video_reels`);
    url.searchParams.set("access_token", accessToken);

    let reels: Array<{ id: string; description?: string; updated_time?: string }> = [];
    try {
      const response = await fetch(url.toString());
      const data = await handle<{ data?: typeof reels }>(response);
      reels = data.data ?? [];
    } catch (error) {
      console.warn(
        "[facebook] video_reels unavailable:",
        error instanceof Error ? error.message : error
      );
    }

    return reels.slice(0, limit).map((reel) => ({
      id: reel.id,
      caption: reel.description ?? null,
      permalink: null,
      thumbnailUrl: null,
      videoUrl: null,
      mediaType: "REEL",
      timestamp: reel.updated_time ?? new Date(0).toISOString(),
      isReel: true,
    }));
  },
};

function postbackTemplate(text: string, buttonTitle: string, payload: string) {
  return {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text: text.slice(0, 640),
        buttons: [{ type: "postback", title: buttonTitle.slice(0, 20), payload }],
      },
    },
  };
}

function buttonTemplate(text: string, buttons: LinkButton[]) {
  return {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text: text.slice(0, 640),
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "web_url",
          url: b.url,
          title: b.title.slice(0, 20),
        })),
      },
    },
  };
}

/**
 * `recipient_id` in the response is the commenter's page-scoped id. It is not in
 * the webhook and there is no other way to obtain it, so it is returned rather
 * than dropped.
 */
/** A Send API request body. `recipient` addresses either a comment or a person. */
interface SendRequest {
  recipient: { comment_id: string } | { id: string };
  message: unknown;
}

async function sendToPage(
  accessToken: string,
  pageId: string,
  body: SendRequest
): Promise<SendResult> {
  const response = await fetch(`${graphBase()}/${pageId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, access_token: accessToken }),
  });
  const data = await handle<{ recipient_id?: string; message_id?: string }>(response);
  return { messageId: data.message_id, discoveredUserId: data.recipient_id };
}