/**
 * TikTok, via the Business Account API.
 *
 * Verified against TikTok's documentation on 2026-08-24.
 *
 * Two developer platforms exist and only one of them can do this.
 * `developers.tiktok.com` has exactly 17 scopes and none is `comment.*` or
 * `message.*`, so comment access lives on `business-api.tiktok.com`. That
 * platform bars individual developers and requires a company entity.
 *
 * `messaging` is null. TikTok states plainly that you are prohibited from
 * initiating a conversation with any user who has not started one with you. The
 * single carve-out, Comment-to-Message, reaches only Business Accounts
 * registered in Vietnam, Indonesia, and Thailand, only commenters in
 * APAC/LATAM/METAP, and fires on TikTok's own high-intent classifier rather than
 * a keyword we choose. Modelling it as a capability we have would be a lie.
 *
 * The public comment reply ships globally with no security review, and the
 * `comment.update` webhook carries the comment text, so a keyword match needs no
 * follow-up read.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { requireEnv } from "@/lib/env";
import type {
  DiscoveredComment,
  CommentEvent,
  Discovery,
  InsightsCapability,
  Metric,
  MetricValues,
  PlatformAdapter,
  PlatformEvent,
  PostSummary,
} from "./types";
import { PLATFORM_CAPABILITIES, PLATFORM_METRICS } from "./types";

const API = "https://business-api.tiktok.com/open_api/v1.3";

/** Everything the shippable product needs. Messaging scopes are not among them. */
export const TIKTOK_SCOPES = [
  "user.info.basic",
  "video.list",
  "comment.list",
  "comment.list.manage",
] as const;

/**
 * TikTok rejects a redirect URL that does not end in a slash, and rejects one
 * with a query or an anchor. Normalising here means a caller cannot get it
 * subtly wrong and find out at the consent screen.
 */
function withTrailingSlash(url: string): string {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  if (!parsed.pathname.endsWith("/")) parsed.pathname = `${parsed.pathname}/`;
  return parsed.toString();
}

/**
 * Per authorized account per endpoint. There is also an app-wide ceiling of 600
 * QPM at the default tier, which is what makes polling impractical and webhooks
 * the primary path.
 */
export const TIKTOK_ACCOUNT_QPM = 40;

interface TikTokEnvelope {
  event?: string;
  user_openid?: string;
  /** A JSON-encoded string, not a nested object. */
  content?: string;
}

interface CommentUpdateContent {
  comment_id?: number | string;
  video_id?: number | string;
  parent_comment_id?: number | string;
  comment_type?: string;
  comment_action?: string;
  unique_identifier?: string;
  text?: string;
}

async function call<T>(
  path: string,
  accessToken: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      // Not `Authorization: Bearer`. TikTok uses its own header name.
      "Access-Token": accessToken,
    },
  });
  // SAFETY: every field is optional, and `code` is what the branch below
  // reads. A non-zero or absent-on-failure code throws before `data` is used.
  const data = (await response.json()) as { code?: number; message?: string; data?: T };
  if (!response.ok || (data.code !== undefined && data.code !== 0)) {
    throw new Error(`TikTok API error: ${data.message ?? response.statusText} [code=${data.code ?? response.status}]`);
  }
  // SAFETY: reached only past the code check above, which is TikTok's success
  // signal for the envelope carrying T.
  return data.data as T;
}

const discovery: Discovery = {
  kind: "webhook",

  /**
   * ⚠️ Unverified. TikTok's webhook configuration accepts a `secret`, but the
   * signing algorithm, header name, and signed byte range are not documented
   * anywhere I could find.
   *
   * Refusing every payload until the scheme is confirmed is the only safe
   * default. An ingestion endpoint that triggers outbound activity on a
   * creator's account is the highest-severity thing in this system to leave
   * unauthenticated, so this fails closed and the route stays disabled by
   * configuration until a spike resolves it.
   */
  verifySignature(rawBody: string, signature: string | null): boolean {
    const secret = process.env.TIKTOK_WEBHOOK_SECRET;
    if (!secret || !signature) return false;

    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  },

  parseEvents(payload: unknown): PlatformEvent[] {
    // SAFETY: every field on TikTokEnvelope is optional, and the `event` check
    // on the next line rejects anything that is not a comment.update webhook.
    const envelope = payload as TikTokEnvelope;
    if (envelope?.event !== "comment.update") return [];

    const accountId = envelope.user_openid;
    if (!accountId || typeof envelope.content !== "string") return [];

    let content: CommentUpdateContent;
    try {
      // SAFETY: every field is optional and each one is re-checked below before
      // use, so a payload of the wrong shape yields no events rather than bad
      // ones. A string that is not JSON throws into the catch.
      content = JSON.parse(envelope.content) as CommentUpdateContent;
    } catch {
      return [];
    }

    // Only a newly published comment is actionable. `delete`, `set_to_hidden`,
    // and `set_to_public` all arrive on the same event, and `set_to_public` is
    // separately useful as the signal that our own reply escaped spam filtering.
    if (content.comment_action !== "insert") return [];

    const commentId = content.comment_id;
    const videoId = content.video_id;
    const author = content.unique_identifier;
    if (commentId === undefined || videoId === undefined || !author) return [];

    const event: CommentEvent = {
      kind: "comment",
      platform: "TIKTOK",
      accountExternalId: accountId,
      commentId: String(commentId),
      commentText: content.text ?? "",
      // The identifier is consistent across TikTok's comment and messaging APIs,
      // which is the only join between a commenter and a conversation.
      commenterId: author,
      postId: String(videoId),
    };
    if (content.parent_comment_id !== undefined && content.comment_type === "reply") {
      event.parentCommentId = String(content.parent_comment_id);
    }
    return [event];
  },
};

const TT_LABELS = {
  VIEWS: "Video views",
  LIKES: "Likes",
  COMMENTS: "Comments",
  SHARES: "Shares",
  REACH: "Reach",
  SAVES: "Saved",
} satisfies Record<Metric, string>;

/**
 * `/business/video/list/` returns metrics alongside the videos when asked, so
 * the whole report is one call. There is no per-video insights edge to fan out
 * across, which is why this adapter needs no concurrency bound.
 */
const insights: InsightsCapability = {
  metrics: PLATFORM_METRICS.TIKTOK,

  async buildReport(accessToken, businessId, { limit }) {
    const params = new URLSearchParams({
      business_id: businessId,
      max_count: String(Math.min(limit, 20)),
      fields: JSON.stringify([
        "item_id",
        "caption",
        "share_url",
        "thumbnail_url",
        "create_time",
        "video_views",
        "likes",
        "comments",
        "shares",
      ]),
    });

    const data = await call<{
      videos?: Array<{
        item_id?: string;
        caption?: string;
        share_url?: string;
        thumbnail_url?: string;
        create_time?: number;
        video_views?: number;
        likes?: number;
        comments?: number;
        shares?: number;
      }>;
    }>(`/business/video/list/?${params.toString()}`, accessToken);

    const rows = (data?.videos ?? []).flatMap((video) => {
      if (!video.item_id) return [];
      const values: MetricValues = {};
      if (video.video_views !== undefined) values.VIEWS = video.video_views;
      if (video.likes !== undefined) values.LIKES = video.likes;
      if (video.comments !== undefined) values.COMMENTS = video.comments;
      if (video.shares !== undefined) values.SHARES = video.shares;

      return [
        {
          post: {
            id: video.item_id,
            caption: video.caption ?? null,
            permalink: video.share_url ?? null,
            thumbnailUrl: video.thumbnail_url ?? null,
            videoUrl: null,
            mediaType: "VIDEO",
            timestamp: video.create_time
              ? new Date(video.create_time * 1000).toISOString()
              : new Date(0).toISOString(),
            isReel: true,
          },
          values,
        },
      ];
    });

    let followers: number | null = null;
    try {
      const accountParams = new URLSearchParams({
        business_id: businessId,
        fields: JSON.stringify(["followers_count"]),
      });
      const account = await call<{ followers_count?: number }>(
        `/business/get/?${accountParams.toString()}`,
        accessToken
      );
      followers = account?.followers_count ?? null;
    } catch {
      // The report stands without it.
    }

    const metrics = PLATFORM_METRICS.TIKTOK;
    return {
      tiles: metrics.map((metric, index) => ({
        metric,
        label: TT_LABELS[metric],
        value: rows.reduce<number | null>(
          (sum, row) =>
            row.values[metric] === undefined ? sum : (sum ?? 0) + row.values[metric],
          null
        ),
        rank: index + 1,
      })),
      columns: metrics.map((metric) => ({ metric, label: TT_LABELS[metric] })),
      rows,
      audience:
        followers === null
          ? null
          : { noun: "followers", current: followers, history: [] },
      notices: [],
    };
  },
};

export const tiktokAdapter: PlatformAdapter = {
  insights,
  /**
   * The conversation list exists, but it returns a conversation id without the
   * identifier that attributes it to a commenter, and initiating a conversation
   * is prohibited outside three countries. An inbox that can neither attribute
   * nor answer a thread is not one, so this stays null until the messaging
   * carve-out is something we actually hold.
   */
  conversations: null,
  platform: "TIKTOK",
  capabilities: PLATFORM_CAPABILITIES.TIKTOK,
  discovery,
  messaging: null,

  /**
   * The access token lasts one day and the refresh token one year. When the
   * refresh token expires the creator has to authorize again, which no cron can
   * recover from, so that failure has to surface rather than be retried.
   */
  /**
   * ⚠️ Unverified against a live app. Written from TikTok's documented endpoints
   * so it is ready when registration and the Accounts API form come through.
   *
   * Two details bite. `disable_auto_auth=1` is required or a returning user is
   * silently redirected back with no `auth_code` at all. And redirect URLs must
   * end with a trailing slash, with no query, no anchor and no port, which is
   * why the caller's URI is normalised here rather than trusted.
   */
  oauth: {
    authorizeUrl(app, redirectUri, state) {
      const url = new URL("https://business-api.tiktok.com/portal/auth");
      url.searchParams.set("app_id", app.appId);
      url.searchParams.set("redirect_uri", withTrailingSlash(redirectUri));
      url.searchParams.set("state", state);
      // Without this a returning user is redirected with no auth_code.
      url.searchParams.set("disable_auto_auth", "1");
      return url.toString();
    },

    async exchange(app, code, redirectUri) {
      const token = await call<{
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        open_id?: string;
        scope?: string[];
      }>("/tt_user/oauth2/token/", "", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_key: app.appId,
          client_secret: app.appSecret,
          auth_code: code,
          grant_type: "authorization_code",
          redirect_uri: withTrailingSlash(redirectUri),
        }),
      });

      if (!token?.access_token || !token.open_id) {
        throw new Error("TikTok returned no access token");
      }

      const profile = await call<{
        core_info?: { username?: string; display_name?: string; region?: string };
      }>(
        `/business/get/?business_id=${encodeURIComponent(token.open_id)}&fields=["username","display_name","region"]`,
        token.access_token
      ).catch(() => null);

      return [
        {
          // `open_id` is the account's own id and every Business API call passes
          // it as `business_id`, which is why it is the external id here.
          externalId: token.open_id,
          username: profile?.core_info?.username ?? token.open_id,
          displayName: profile?.core_info?.display_name ?? null,
          accessToken: token.access_token,
          refreshToken: token.refresh_token ?? null,
          expiresInSeconds: token.expires_in ?? 86_400,
          // The registration market decides whether messaging is available at
          // all, so a missing one must not read as eligible.
          region: profile?.core_info?.region ?? null,
          grantedScopes: token.scope ?? [...TIKTOK_SCOPES],
        },
      ];
    },
  } as const,

  tokens: {
    kind: "refreshable",
    refreshWithinMs: 6 * 3_600_000,
    async refresh(_accessToken: string, refreshToken: string | null) {
      if (!refreshToken) {
        throw new Error("TikTok cannot refresh without a stored refresh token");
      }
      const data = await call<{
        access_token?: string;
        expires_in?: number;
        refresh_token?: string;
      }>("/tt_user/oauth2/refresh_token/", "", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_key: requireEnv("TIKTOK_CLIENT_KEY"),
          client_secret: requireEnv("TIKTOK_CLIENT_SECRET"),
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });
      if (!data?.access_token) throw new Error("TikTok returned no access token");
      return {
        accessToken: data.access_token,
        expiresInSeconds: data.expires_in ?? 86_400,
        refreshToken: data.refresh_token,
      };
    },
  } as const,


  /**
   * TikTok warns that a high volume of similar comments in a short window gets
   * flagged as spam and hidden. When that happens the `comment.update` webhook
   * for `set_to_public` never arrives, which is the only signal that a reply was
   * shadow-hidden. Reply copy should vary; the campaign's variant pool is what
   * provides that.
   */
  async postPublicReply(accessToken, accountExternalId, commentId, message) {
    const data = await call<{ comment_id?: string }>(
      "/business/comment/reply/create/",
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_id: accountExternalId,
          comment_id: commentId,
          // 1,200 UTF-8 characters is the documented ceiling.
          text: message.slice(0, 1200),
        }),
      }
    );
    return { id: data?.comment_id ?? commentId };
  },

  /**
   * The `comment.update` webhook is the primary path and carries the text, so
   * this exists to reconcile what a missed delivery left behind. TikTok warns
   * that past 500 comments the pages are not deduplicated, which is why the
   * caller dedupes on id rather than trusting the cursor.
   */
  async listRecentComments(accessToken, accountExternalId, { postIds, sinceMs }) {
    const found: DiscoveredComment[] = [];

    for (const postId of postIds) {
      const params = new URLSearchParams({
        business_id: accountExternalId,
        video_id: postId,
        status: "PUBLIC",
        sort_field: "create_time",
        sort_order: "desc",
        max_count: "30",
      });

      const data = await call<{
        comments?: Array<{
          comment_id?: string | number;
          text?: string;
          unique_identifier?: string;
          display_name?: string;
          create_time?: number;
          reply_list?: Array<{ unique_identifier?: string }>;
        }>;
      }>(`/business/comment/list/?${params.toString()}`, accessToken);

      for (const c of data?.comments ?? []) {
        if (c.comment_id === undefined || !c.unique_identifier) continue;
        const createdAtMs = c.create_time ? c.create_time * 1000 : null;
        if (createdAtMs !== null && createdAtMs < sinceMs) continue;
        found.push({
          id: String(c.comment_id),
          postId,
          text: c.text ?? "",
          authorId: c.unique_identifier,
          authorName: c.display_name ?? null,
          createdAtMs,
          ownerHasReplied: (c.reply_list ?? []).some(
            (r) => r.unique_identifier === accountExternalId
          ),
        });
      }
    }

    return found;
  },

  async listPosts(accessToken, businessId, limit): Promise<PostSummary[]> {
    const params = new URLSearchParams({
      business_id: businessId,
      max_count: String(Math.min(limit, 20)),
    });

    const data = await call<{
      videos?: Array<{
        item_id?: string;
        caption?: string;
        share_url?: string;
        thumbnail_url?: string;
        create_time?: number;
      }>;
    }>(`/business/video/list/?${params.toString()}`, accessToken);

    return (data?.videos ?? []).flatMap((video) => {
      if (!video.item_id) return [];
      return [
        {
          id: video.item_id,
          caption: video.caption ?? null,
          permalink: video.share_url ?? null,
          thumbnailUrl: video.thumbnail_url ?? null,
          videoUrl: null,
          mediaType: "VIDEO",
          timestamp: video.create_time
            ? new Date(video.create_time * 1000).toISOString()
            : new Date(0).toISOString(),
          // Every TikTok post is short-form video, so the distinction other
          // platforms draw does not exist here.
          isReel: true,
        },
      ];
    });
  },
};
