import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";

vi.stubEnv("TIKTOK_WEBHOOK_SECRET", "tt_secret");

import { youtubeAdapter, isShortDuration, YOUTUBE_QUOTA } from "../lib/platforms/youtube";
import { tiktokAdapter } from "../lib/platforms/tiktok";
import { supports } from "../lib/platforms/types";

/**
 * The design's central claim, for the two platforms that forced it. A platform
 * with no messaging API must have no way to be asked for one, rather than a
 * method that throws.
 */
describe("platforms that cannot message", () => {
  it.each([
    ["youtube", youtubeAdapter],
    ["tiktok", tiktokAdapter],
  ])("%s exposes no messaging surface at all", (_name, adapter) => {
    expect(adapter.messaging).toBeNull();
  });

  it.each([
    ["YOUTUBE" as const],
    ["TIKTOK" as const],
  ])("%s declares no DM capability", (platform) => {
    expect(supports(platform, "PRIVATE_REPLY")).toBe(false);
    expect(supports(platform, "CONVERSATION_MESSAGE")).toBe(false);
    expect(supports(platform, "FOLLOW_GATE")).toBe(false);
  });

  it.each([
    ["youtube", youtubeAdapter],
    ["tiktok", tiktokAdapter],
  ])("%s can still post the universal public reply", (_name, adapter) => {
    expect(supports(adapter.platform, "PUBLIC_REPLY")).toBe(true);
    expect(adapter.postPublicReply).toBeTypeOf("function");
  });
});

describe("youtube discovery", () => {
  /**
   * WebSub notifies on new videos, title edits, and description edits only.
   * There is no comment webhook, so polling is the only path rather than a
   * safety net.
   */
  it("is poll-only, with no signature or parser to call", () => {
    expect(youtubeAdapter.discovery.kind).toBe("poll");
    expect(youtubeAdapter.discovery).not.toHaveProperty("verifySignature");
    expect(youtubeAdapter.discovery).not.toHaveProperty("parseEvents");
  });

  /** A poll costs 1 unit and a reply costs 50, which is what paces the scheduler. */
  it("prices a poll at one unit against a reply at fifty", () => {
    expect(youtubeAdapter.discovery).toMatchObject({ pollCost: 1 });
    expect(YOUTUBE_QUOTA.commentsInsert).toBe(50);
  });
});

describe("youtube shorts detection", () => {
  it.each([
    ["PT30S", true],
    ["PT3M", true],
    ["PT2M59S", true],
    ["PT3M1S", false],
    ["PT10M", false],
  ])("treats %s as a short: %s", (duration, expected) => {
    expect(isShortDuration(duration)).toBe(expected);
  });

  /** Durations with an hour component are never Shorts and must not parse. */
  it("rejects a duration it cannot interpret", () => {
    expect(isShortDuration("PT1H2M")).toBe(false);
    expect(isShortDuration("")).toBe(false);
  });
});

describe("tiktok comment webhook", () => {
  function envelope(content: Record<string, unknown>, event = "comment.update") {
    return { event, user_openid: "open_1", content: JSON.stringify(content) };
  }

  const insert = {
    comment_id: 7280000000000000000,
    video_id: 7270000000000000000,
    comment_type: "comment",
    comment_action: "insert",
    unique_identifier: "uid_abc",
    text: "LINK please",
  };

  it("parses a newly published comment", () => {
    const events = tiktokAdapter.discovery.kind === "webhook"
      ? tiktokAdapter.discovery.parseEvents(envelope(insert))
      : [];

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "comment",
      platform: "TIKTOK",
      accountExternalId: "open_1",
      commentText: "LINK please",
      commenterId: "uid_abc",
    });
  });

  /** Ids arrive as numbers and would lose precision if left as JS numbers. */
  it("keeps large ids exact by carrying them as strings", () => {
    const events = tiktokAdapter.discovery.kind === "webhook"
      ? tiktokAdapter.discovery.parseEvents(envelope(insert))
      : [];

    expect(events[0]).toMatchObject({
      commentId: "7280000000000000000",
      postId: "7270000000000000000",
    });
  });

  it.each([["delete"], ["set_to_hidden"], ["set_to_public"]])(
    "ignores the %s action, which shares the same event",
    (action) => {
      const events = tiktokAdapter.discovery.kind === "webhook"
        ? tiktokAdapter.discovery.parseEvents(envelope({ ...insert, comment_action: action }))
        : [];
      expect(events).toHaveLength(0);
    }
  );

  it("ignores an event type it does not handle", () => {
    const events = tiktokAdapter.discovery.kind === "webhook"
      ? tiktokAdapter.discovery.parseEvents(envelope(insert, "im_receive_msg"))
      : [];
    expect(events).toHaveLength(0);
  });

  /** `content` is a JSON-encoded string, not a nested object. */
  it("survives a content field that is not valid JSON", () => {
    const events = tiktokAdapter.discovery.kind === "webhook"
      ? tiktokAdapter.discovery.parseEvents({
          event: "comment.update",
          user_openid: "open_1",
          content: "{not json",
        })
      : [];
    expect(events).toHaveLength(0);
  });

  it("marks a reply to another comment", () => {
    const events = tiktokAdapter.discovery.kind === "webhook"
      ? tiktokAdapter.discovery.parseEvents(
          envelope({ ...insert, comment_type: "reply", parent_comment_id: 7260000000000000000 })
        )
      : [];
    expect(events[0]).toMatchObject({ parentCommentId: "7260000000000000000" });
  });
});

/**
 * TikTok's webhook signing scheme is not documented. Until a spike confirms the
 * algorithm and header, refusing every payload is the only safe default for an
 * endpoint that triggers outbound activity on a creator's account.
 */
describe("tiktok signature verification, which is unverified upstream", () => {
  beforeEach(() => vi.unstubAllEnvs());

  it("refuses when no signature is presented", () => {
    vi.stubEnv("TIKTOK_WEBHOOK_SECRET", "tt_secret");
    const ok = tiktokAdapter.discovery.kind === "webhook"
      ? tiktokAdapter.discovery.verifySignature("{}", null)
      : true;
    expect(ok).toBe(false);
  });

  it("refuses when no secret is configured, rather than accepting", () => {
    const body = "{}";
    const sig = createHmac("sha256", "tt_secret").update(body).digest("hex");
    const ok = tiktokAdapter.discovery.kind === "webhook"
      ? tiktokAdapter.discovery.verifySignature(body, sig)
      : true;
    expect(ok).toBe(false);
  });

  it("refuses a signature computed with the wrong secret", () => {
    vi.stubEnv("TIKTOK_WEBHOOK_SECRET", "tt_secret");
    const body = "{}";
    const sig = createHmac("sha256", "wrong").update(body).digest("hex");
    const ok = tiktokAdapter.discovery.kind === "webhook"
      ? tiktokAdapter.discovery.verifySignature(body, sig)
      : true;
    expect(ok).toBe(false);
  });
});
