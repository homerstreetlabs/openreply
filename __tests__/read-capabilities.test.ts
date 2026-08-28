import { describe, it, expect, vi, afterEach } from "vitest";

vi.stubEnv("TIKTOK_WEBHOOK_SECRET", "tt_secret");

import { ADAPTERS } from "../lib/platforms/registry";
import { instagramAdapter } from "../lib/platforms/instagram";
import { youtubeAdapter } from "../lib/platforms/youtube";
import { tiktokAdapter } from "../lib/platforms/tiktok";

import { PLATFORM_METRICS, supports, type Platform } from "../lib/platforms/types";

const PLATFORMS = Object.keys(ADAPTERS) as Platform[];

describe("every platform answers both read questions", () => {
  it.each(PLATFORMS)("%s declares insights and conversations", (platform) => {
    const adapter = ADAPTERS[platform];
    expect(adapter).toHaveProperty("insights");
    expect(adapter).toHaveProperty("conversations");
  });

  it.each(PLATFORMS)("%s reports only metrics its platform table allows", (platform) => {
    const { insights } = ADAPTERS[platform];
    if (!insights) return;
    expect([...insights.metrics].sort()).toEqual([...PLATFORM_METRICS[platform]].sort());
  });
});

/**
 * The bug this layer exists to close. `CONVERSATION_HISTORY` sat in the
 * capability table for Facebook with nothing behind it, so the inbox offered a
 * Page and then failed against an Instagram-only client. The claim and the
 * implementation have to be the same fact.
 */
describe("the capability table cannot outrun the implementation", () => {
  it.each(PLATFORMS)(
    "%s implements conversations exactly when it claims CONVERSATION_HISTORY",
    (platform) => {
      const claims = supports(platform, "CONVERSATION_HISTORY");
      expect(ADAPTERS[platform].conversations !== null).toBe(claims);
    }
  );
});

describe("platforms with no readable inbox", () => {
  it.each([
    ["youtube", youtubeAdapter],
    ["tiktok", tiktokAdapter],
  ])("%s exposes no conversation surface to call", (_name, adapter) => {
    expect(adapter.conversations).toBeNull();
  });

  it.each([
    ["youtube", youtubeAdapter],
    ["tiktok", tiktokAdapter],
  ])("%s still reports analytics", (_name, adapter) => {
    expect(adapter.insights).not.toBeNull();
  });
});

describe("instagram report", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function media(id: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      caption: `caption ${id}`,
      media_type: "IMAGE",
      timestamp: "2026-08-01T00:00:00+0000",
      permalink: `https://instagram.com/p/${id}`,
      like_count: 10,
      comments_count: 2,
      ...extra,
    };
  }

  /** The two envelope shapes the Graph API returns on this path. */
  type GraphBody =
    | { data: ReturnType<typeof media>[] }
    | { data: Array<{ name: string; values: Array<{ value: number }> }> };

  function respond(body: GraphBody) {
    return Promise.resolve({
      ok: true,
      url: "https://graph.instagram.com/x",
      json: () => Promise.resolve(body),
    } as Response);
  }

  it("sums each metric across the posts it fetched", async () => {
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/insights")) {
        return respond({
          data: [
            { name: "reach", values: [{ value: 100 }] },
            { name: "saved", values: [{ value: 3 }] },
            { name: "shares", values: [{ value: 1 }] },
          ],
        });
      }
      return respond({ data: [media("a"), media("b")] });
    }) as typeof fetch;

    const report = await instagramAdapter.insights!.buildReport("tok", "acct", {
      limit: 50,
    });

    const reach = report.tiles.find((t) => t.metric === "REACH");
    const likes = report.tiles.find((t) => t.metric === "LIKES");
    expect(reach?.value).toBe(200);
    expect(likes?.value).toBe(20);
    expect(report.rows).toHaveLength(2);
  });

  /**
   * A token granted before the insights scope must still return the likes and
   * comments that ride along with the media fields. Degrading to nothing is
   * what the old route did by throwing.
   */
  it("degrades to the always-available metrics when insights are refused", async () => {
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/insights")) {
        return Promise.resolve({
          ok: false,
          status: 403,
          url,
          json: () =>
            Promise.resolve({
              error: { message: "no permission", code: 10, type: "OAuthException" },
            }),
        } as Response);
      }
      return respond({ data: [media("a")] });
    }) as typeof fetch;

    const report = await instagramAdapter.insights!.buildReport("tok", "acct", {
      limit: 50,
    });

    expect(report.tiles.map((t) => t.metric).sort()).toEqual(["COMMENTS", "LIKES"]);
    expect(report.notices.some((n) => n.kind === "permission")).toBe(true);
    expect(report.rows[0].values.LIKES).toBe(10);
  });

  it("says so when it hit the post ceiling", async () => {
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/insights")) return respond({ data: [] });
      return respond({ data: [media("a"), media("b")] });
    }) as typeof fetch;

    const report = await instagramAdapter.insights!.buildReport("tok", "acct", {
      limit: 2,
    });
    expect(report.notices.some((n) => n.kind === "truncated")).toBe(true);
  });
});

describe("tile ranks drive display order", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("instagram ranks every tile uniquely", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        url: "https://graph.instagram.com/x",
        json: () => Promise.resolve({ data: [] }),
      } as Response)
    ) as typeof fetch;

    const report = await instagramAdapter.insights!.buildReport("tok", "acct", {
      limit: 10,
    });
    const ranks = report.tiles.map((t) => t.rank);
    // A tie leaves the order of two tiles undefined between renders.
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});
