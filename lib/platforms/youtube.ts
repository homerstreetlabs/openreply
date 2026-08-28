/**
 * YouTube, including Shorts.
 *
 * Verified against Google's documentation on 2026-08-24. Three facts shape this
 * adapter and none of them are workarounds.
 *
 * There is no messaging API. The Data API has no messaging resource, and the
 * `comment` resource exposes only `authorDisplayName`, `authorProfileImageUrl`,
 * `authorChannelUrl`, and `authorChannelId.value`, so there is no identifier a
 * message could be routed to. `messaging` is therefore null rather than a set of
 * methods that throw.
 *
 * There is no comment webhook. WebSub notifies on new videos, title edits, and
 * description edits, and nothing else, so discovery is poll-only.
 *
 * Quota is the binding constraint and it is per Google Cloud project, shared
 * across every creator. `commentThreads.list` costs 1 unit and `comments.insert`
 * costs 50, against 10,000 units a day, so the whole product can post about 200
 * automated replies a day before a compliance audit. Sharding across projects to
 * get more is explicitly forbidden by the Developer Policies.
 */

import { requireEnv } from "@/lib/env";
import type {
  Discovery,
  InsightsCapability,
  Metric,
  MetricValues,
  PlatformAdapter,
  PostSummary,
} from "./types";
import { PLATFORM_CAPABILITIES, PLATFORM_METRICS } from "./types";

/** The only write scope Google offers. There is no narrower one for a reply. */
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.force-ssl",
] as const;

const API = "https://www.googleapis.com/youtube/v3";

/** Documented quota cost per call. The 50x gap decides the whole scheduler. */
export const YOUTUBE_QUOTA = {
  commentThreadsList: 1,
  commentsInsert: 50,
  videosList: 1,
  playlistItemsList: 1,
  channelsList: 1,
} as const;

interface CommentThreadsResponse {
  items?: Array<{
    id?: string;
    snippet?: {
      videoId?: string;
      topLevelComment?: {
        id?: string;
        snippet?: {
          textOriginal?: string;
          publishedAt?: string;
          authorDisplayName?: string;
          authorChannelId?: { value?: string };
        };
      };
    };
  }>;
  nextPageToken?: string;
}

async function call<T>(url: URL, accessToken: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url.toString(), {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${accessToken}` },
  });
  // SAFETY: the Data API returns either the requested shape or an `error`
  // object. The branch below throws on the error case, so only callers of a
  // successful response observe T.
  const data = (await response.json()) as T & {
    error?: { message?: string; code?: number };
  };
  if (!response.ok || data.error) {
    throw new Error(
      `YouTube API error: ${data.error?.message ?? response.statusText} [code=${data.error?.code ?? response.status}]`
    );
  }
  return data;
}

/**
 * Recent comment threads across every video on a channel.
 *
 * One call covers the whole channel, which is why per-video polling is never
 * necessary and why the poll costs a single quota unit.
 */
export async function listRecentComments(
  accessToken: string,
  channelId: string,
  pageToken?: string
): Promise<{
  comments: Array<{
    commentId: string;
    videoId: string;
    text: string;
    authorChannelId: string;
    authorName: string;
    publishedAtMs: number | null;
  }>;
  nextPageToken?: string;
}> {
  const url = new URL(`${API}/commentThreads`);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("allThreadsRelatedToChannelId", channelId);
  url.searchParams.set("order", "time");
  url.searchParams.set("maxResults", "100");
  if (pageToken) url.searchParams.set("pageToken", pageToken);

  const data = await call<CommentThreadsResponse>(url, accessToken);

  const comments = (data.items ?? []).flatMap((item) => {
    const top = item.snippet?.topLevelComment;
    const commentId = top?.id;
    const authorChannelId = top?.snippet?.authorChannelId?.value;
    const videoId = item.snippet?.videoId;
    if (!commentId || !authorChannelId || !videoId) return [];
    return [
      {
        commentId,
        videoId,
        text: top?.snippet?.textOriginal ?? "",
        authorChannelId,
        authorName: top?.snippet?.authorDisplayName ?? "",
        publishedAtMs: top?.snippet?.publishedAt
          ? (Date.parse(top.snippet.publishedAt) || null)
          : null,
      },
    ];
  });

  return { comments, nextPageToken: data.nextPageToken };
}

const discovery: Discovery = {
  kind: "poll",
  pollCost: YOUTUBE_QUOTA.commentThreadsList,
};

const YT_LABELS = {
  VIEWS: "Views",
  LIKES: "Likes",
  COMMENTS: "Comments",
  REACH: "Reach",
  SAVES: "Saved",
  SHARES: "Shares",
} satisfies Record<Metric, string>;

/**
 * `videos.list` costs one quota unit and accepts up to 50 ids, so a whole
 * report's statistics arrive in one call rather than one per video. Against a
 * 10,000-unit daily budget shared by every creator, that difference is the
 * whole reason Overview is affordable here.
 */
const insights: InsightsCapability = {
  metrics: PLATFORM_METRICS.YOUTUBE,

  async buildReport(accessToken, channelId, { limit }) {
    const posts = await youtubeAdapter.listPosts(accessToken, channelId, limit);
    if (posts.length === 0) {
      return { tiles: [], columns: [], rows: [], audience: null, notices: [] };
    }

    const videos = new URL(`${API}/videos`);
    videos.searchParams.set("part", "statistics");
    videos.searchParams.set("id", posts.map((p) => p.id).join(","));

    const stats = await call<{
      items?: Array<{
        id?: string;
        statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
      }>;
    }>(videos, accessToken);

    // Counts arrive as strings, and a video with likes hidden omits the field
    // entirely rather than returning zero.
    const byId = new Map(
      (stats.items ?? []).map((item) => {
        const s = item.statistics ?? {};
        const values: MetricValues = {};
        if (s.viewCount !== undefined) values.VIEWS = Number(s.viewCount);
        if (s.likeCount !== undefined) values.LIKES = Number(s.likeCount);
        if (s.commentCount !== undefined) values.COMMENTS = Number(s.commentCount);
        return [item.id, values];
      })
    );

    const rows = posts.map((post) => ({ post, values: byId.get(post.id) ?? {} }));

    let subscribers: number | null = null;
    try {
      const channels = new URL(`${API}/channels`);
      channels.searchParams.set("part", "statistics");
      channels.searchParams.set("id", channelId);
      const channelData = await call<{
        items?: Array<{ statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean } }>;
      }>(channels, accessToken);
      const channelStats = channelData.items?.[0]?.statistics;
      // A channel may hide its subscriber count, which is an absence rather
      // than a zero and must not be charted as one.
      subscribers =
        channelStats?.hiddenSubscriberCount || channelStats?.subscriberCount === undefined
          ? null
          : Number(channelStats.subscriberCount);
    } catch {
      // The report stands without it.
    }

    const metrics = PLATFORM_METRICS.YOUTUBE;
    return {
      tiles: metrics.map((metric, index) => ({
        metric,
        label: YT_LABELS[metric],
        value: rows.reduce<number | null>(
          (sum, row) =>
            row.values[metric] === undefined ? sum : (sum ?? 0) + row.values[metric],
          null
        ),
        rank: index + 1,
      })),
      columns: metrics.map((metric) => ({ metric, label: YT_LABELS[metric] })),
      rows,
      audience:
        subscribers === null
          ? null
          : { noun: "subscribers", current: subscribers, history: [] },
      notices: [],
    };
  },
};

export const youtubeAdapter: PlatformAdapter = {
  insights,
  /**
   * No messaging resource means no conversation to read. Null is the honest
   * answer, and it is what keeps the account out of the inbox picker.
   */
  conversations: null,
  platform: "YOUTUBE",
  capabilities: PLATFORM_CAPABILITIES.YOUTUBE,
  discovery,

  /**
   * No messaging API exists. This is the whole reason `messaging` is a nullable
   * field rather than a set of methods, so that the absence is a fact the
   * compiler carries rather than a runtime throw.
   */
  messaging: null,

  /**
   * Google issues a separate refresh token and the access token lasts an hour,
   * so this refreshes far more often than the Meta platforms do.
   */
  /**
   * ⚠️ Unverified against a live app. Written from Google's documented endpoints
   * so it is ready the day OAuth verification lands, but nobody has run it: the
   * `youtube.force-ssl` scope is sensitive and needs verification first.
   *
   * `access_type=offline` and `prompt=consent` are both load-bearing. Without
   * them Google returns no refresh token on a re-authorization, and the account
   * silently becomes unrefreshable an hour later.
   */
  oauth: {
    authorizeUrl(app, redirectUri, state) {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", app.appId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", YOUTUBE_SCOPES.join(" "));
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchange(app, code, redirectUri) {
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: app.appId,
          client_secret: app.appSecret,
          code,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
      // SAFETY: every field is optional, and the branch below throws before any
      // of them is read on a failure.
      const token = (await response.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
        error_description?: string;
      };
      if (!response.ok || !token.access_token) {
        throw new Error(
          `YouTube token exchange failed: ${token.error_description ?? response.statusText}`
        );
      }

      const url = new URL(`${API}/channels`);
      url.searchParams.set("part", "snippet");
      url.searchParams.set("mine", "true");
      const accessToken = token.access_token;
      const channels = await call<{
        items?: Array<{ id?: string; snippet?: { title?: string; country?: string } }>;
      }>(url, accessToken);

      return (channels.items ?? []).flatMap((channel) => {
        if (!channel.id) return [];
        return [
          {
            externalId: channel.id,
            username: channel.snippet?.title ?? channel.id,
            displayName: channel.snippet?.title ?? null,
            accessToken,
            refreshToken: token.refresh_token ?? null,
            expiresInSeconds: token.expires_in ?? 3600,
            region: channel.snippet?.country ?? null,
            // Google reports back what was actually granted, which is not always
            // what was asked: a person can untick a scope on the consent screen.
            grantedScopes: token.scope?.split(" ") ?? [...YOUTUBE_SCOPES],
          },
        ];
      });
    },
  } as const,

  tokens: {
    kind: "refreshable",
    refreshWithinMs: 10 * 60_000,
    async refresh(_accessToken: string, refreshToken: string | null) {
      if (!refreshToken) {
        throw new Error("YouTube cannot refresh without a stored refresh token");
      }
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: requireEnv("YOUTUBE_CLIENT_ID"),
          client_secret: requireEnv("YOUTUBE_CLIENT_SECRET"),
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      });
      // SAFETY: every field is optional and the error branch below runs before
      // any of them is read.
      const body = (await response.json()) as {
        access_token?: string;
        expires_in?: number;
        error_description?: string;
      };
      if (!response.ok || !body.access_token) {
        throw new Error(
          `YouTube token refresh failed: ${body.error_description ?? response.statusText}`
        );
      }
      return { accessToken: body.access_token, expiresInSeconds: body.expires_in ?? 3600 };
    },
  } as const,


  /**
   * The only way to reach a commenter. It is public and permanent, and it does
   * reach them, because YouTube's "Replies to my comments" notification setting
   * delivers it to their notifications and email.
   *
   * Costs 50 quota units, which is 50 times a poll.
   */
  async postPublicReply(accessToken, accountExternalId, commentId, message) {
    const url = new URL(`${API}/comments`);
    url.searchParams.set("part", "snippet");

    const data = await call<{ id?: string }>(url, accessToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snippet: { parentId: commentId, textOriginal: message } }),
    });

    if (!data.id) throw new Error("YouTube accepted the reply but returned no id");
    return { id: data.id };
  },

  /**
   * Shorts come from the uploads playlist, not `search.list`, which has its own
   * bucket of 100 calls a day for the entire project.
   *
   * There is no Shorts flag in the Data API. Duration is the only signal
   * available here and it is a heuristic, because a Short is "up to 3 minutes"
   * and any short landscape upload looks identical. The authoritative answer
   * lives in the Analytics API's `creatorContentType` dimension, which is a
   * different API with a different scope, so `isReel` is best-effort.
   */
  async listRecentComments(accessToken, accountExternalId, { postIds, sinceMs }) {
    const { comments } = await listRecentComments(accessToken, accountExternalId);
    const wanted = new Set(postIds);
    return comments
      .filter((c) => (wanted.size === 0 || wanted.has(c.videoId)))
      .filter((c) => c.publishedAtMs === null || c.publishedAtMs >= sinceMs)
      .map((c) => ({
        id: c.commentId,
        postId: c.videoId,
        text: c.text,
        authorId: c.authorChannelId,
        authorName: c.authorName || null,
        createdAtMs: c.publishedAtMs,
        // `commentThreads` returns replies only when asked for them, and asking
        // costs another unit against a pool that buys ~200 replies a day. The
        // ledger answers this for free.
        ownerHasReplied: null,
      }));
  },

  async listPosts(accessToken, channelId, limit): Promise<PostSummary[]> {
    const channels = new URL(`${API}/channels`);
    channels.searchParams.set("part", "contentDetails");
    channels.searchParams.set("id", channelId);

    const channelData = await call<{
      items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }>;
    }>(channels, accessToken);

    const uploads = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return [];

    const items = new URL(`${API}/playlistItems`);
    items.searchParams.set("part", "snippet,contentDetails");
    items.searchParams.set("playlistId", uploads);
    items.searchParams.set("maxResults", String(Math.min(limit, 50)));

    const playlist = await call<{
      items?: Array<{
        contentDetails?: { videoId?: string };
        snippet?: {
          title?: string;
          publishedAt?: string;
          thumbnails?: { medium?: { url?: string } };
        };
      }>;
    }>(items, accessToken);

    const videoIds = (playlist.items ?? [])
      .map((i) => i.contentDetails?.videoId)
      .filter((id): id is string => Boolean(id));
    if (videoIds.length === 0) return [];

    const videos = new URL(`${API}/videos`);
    videos.searchParams.set("part", "contentDetails");
    videos.searchParams.set("id", videoIds.join(","));

    const videoData = await call<{
      items?: Array<{ id?: string; contentDetails?: { duration?: string } }>;
    }>(videos, accessToken);

    const durations = new Map(
      (videoData.items ?? []).map((v) => [v.id, v.contentDetails?.duration ?? ""])
    );

    return (playlist.items ?? []).flatMap((item) => {
      const id = item.contentDetails?.videoId;
      if (!id) return [];
      return [
        {
          id,
          caption: item.snippet?.title ?? null,
          permalink: `https://www.youtube.com/watch?v=${id}`,
          thumbnailUrl: item.snippet?.thumbnails?.medium?.url ?? null,
          videoUrl: null,
          mediaType: "VIDEO",
          timestamp: item.snippet?.publishedAt ?? new Date(0).toISOString(),
          isReel: isShortDuration(durations.get(id) ?? ""),
        },
      ];
    });
  },
};

/** ISO 8601 durations of three minutes or less, the Shorts ceiling. */
export function isShortDuration(iso8601: string): boolean {
  const match = /^PT(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso8601);
  if (!match) return false;
  const minutes = Number(match[1] ?? 0);
  const seconds = Number(match[2] ?? 0);
  return minutes * 60 + seconds <= 180;
}
