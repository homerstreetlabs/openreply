import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";

vi.stubEnv("FACEBOOK_APP_SECRET", "fb_secret");
vi.stubEnv("META_GRAPH_API_VERSION", "v25.0");

import { facebookAdapter } from "../lib/platforms/facebook";
import { PRIVATE_REPLY_WINDOW_HOURS, supports } from "../lib/platforms/types";

const discovery = facebookAdapter.discovery;
if (discovery.kind !== "webhook") throw new Error("facebook must use webhook discovery");

const messaging = facebookAdapter.messaging;
if (!messaging) throw new Error("facebook must have messaging");

function pageComment(overrides: Record<string, unknown> = {}) {
  return {
    object: "page",
    entry: [
      {
        id: "page_123",
        time: 1_760_000_000,
        changes: [
          {
            field: "feed",
            value: {
              item: "comment",
              verb: "add",
              comment_id: "page_123_comment_1",
              post_id: "page_123_reel_9",
              parent_id: "page_123_reel_9",
              created_time: 1_760_000_000,
              message: "LINK please",
              from: { id: "user_777", name: "Jules" },
              ...overrides,
            },
          },
        ],
      },
    ],
  };
}

describe("facebook adapter — signature verification", () => {
  it("accepts a signature produced with the app secret", () => {
    const body = JSON.stringify(pageComment());
    const sig = "sha256=" + createHmac("sha256", "fb_secret").update(body).digest("hex");
    expect(discovery.verifySignature(body, sig)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify(pageComment());
    const sig = "sha256=" + createHmac("sha256", "fb_secret").update(body).digest("hex");
    expect(discovery.verifySignature(body + " ", sig)).toBe(false);
  });

  it("rejects a signature from a different secret", () => {
    const body = JSON.stringify(pageComment());
    const sig = "sha256=" + createHmac("sha256", "wrong").update(body).digest("hex");
    expect(discovery.verifySignature(body, sig)).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(discovery.verifySignature("{}", null)).toBe(false);
  });
});

describe("facebook adapter — comment parsing", () => {
  it("parses a comment on a Page post", () => {
    const events = discovery.parseEvents(pageComment());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "comment",
      platform: "FACEBOOK",
      accountExternalId: "page_123",
      commentId: "page_123_comment_1",
      commentText: "LINK please",
      commenterId: "user_777",
      commenterName: "Jules",
      postId: "page_123_reel_9",
    });
  });

  it("does not mark a top-level comment as a reply", () => {
    const events = discovery.parseEvents(pageComment());
    expect(events[0]).not.toHaveProperty("parentCommentId");
  });

  it("marks a reply to another comment", () => {
    const events = discovery.parseEvents(
      pageComment({ parent_id: "page_123_comment_0" })
    );
    expect(events[0]).toMatchObject({ parentCommentId: "page_123_comment_0" });
  });

  it("ignores the Page commenting on its own post", () => {
    const events = discovery.parseEvents(
      pageComment({ from: { id: "page_123", name: "The Page" } })
    );
    expect(events).toHaveLength(0);
  });

  it("ignores hidden comments", () => {
    expect(discovery.parseEvents(pageComment({ is_hidden: true }))).toHaveLength(0);
  });

  it("ignores edits and deletes, acting only on add", () => {
    expect(discovery.parseEvents(pageComment({ verb: "edited" }))).toHaveLength(0);
    expect(discovery.parseEvents(pageComment({ verb: "remove" }))).toHaveLength(0);
  });

  it("ignores non-comment feed activity", () => {
    expect(
      discovery.parseEvents(pageComment({ item: "reaction", comment_id: undefined }))
    ).toHaveLength(0);
    expect(
      discovery.parseEvents(pageComment({ item: "post", comment_id: undefined }))
    ).toHaveLength(0);
  });

  it("ignores an instagram payload, which has its own adapter", () => {
    expect(
      discovery.parseEvents({ object: "instagram", entry: [{ id: "ig_1" }] })
    ).toHaveLength(0);
  });

  it("keeps an empty comment so keyword matching can decide", () => {
    const events = discovery.parseEvents(pageComment({ message: undefined }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ commentText: "" });
  });

  it("survives a comment with no post_id", () => {
    const events = discovery.parseEvents(
      pageComment({ post_id: undefined, parent_id: undefined })
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ postId: "" });
  });
});

/**
 * Meta documents no `reels` value in the feed `item` enum and publishes no
 * sample payload for a comment on a Reel. These pin the defensive behaviour so
 * a future Meta change surfaces as a failing test rather than dropped comments.
 */
describe("facebook adapter — reel comments, where Meta documents nothing", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("parses a reel comment arriving as an ordinary comment", () => {
    const events = discovery.parseEvents(pageComment({ post_id: "page_123_reel_9" }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ commentId: "page_123_comment_1" });
  });

  it("still acts on a comment whose item value Meta has not documented", () => {
    const events = discovery.parseEvents(pageComment({ item: "reels" }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ commentId: "page_123_comment_1" });
  });

  it("warns when it sees an undocumented item value, so the real shape is discoverable", () => {
    discovery.parseEvents(pageComment({ item: "reels" }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("reels"));
  });

  it("does not act on an unknown item that carries no comment id", () => {
    const events = discovery.parseEvents(
      pageComment({ item: "video", comment_id: undefined })
    );
    expect(events).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("facebook adapter — messaging events", () => {
  function messaging(entry: Record<string, unknown>) {
    return { object: "page", entry: [{ id: "page_123", messaging: [entry] }] };
  }

  it("parses an inbound message", () => {
    const events = discovery.parseEvents(
      messaging({ sender: { id: "user_777" }, message: { mid: "m1", text: "LINK" } })
    );
    expect(events[0]).toMatchObject({
      kind: "message",
      platform: "FACEBOOK",
      senderId: "user_777",
      messageId: "m1",
      messageText: "LINK",
    });
  });

  it("ignores echoes of the page's own messages", () => {
    expect(
      discovery.parseEvents(
        messaging({
          sender: { id: "user_777" },
          message: { mid: "m1", text: "LINK", is_echo: true },
        })
      )
    ).toHaveLength(0);
  });

  it("ignores a message the page sent to itself", () => {
    expect(
      discovery.parseEvents(
        messaging({ sender: { id: "page_123" }, message: { mid: "m1", text: "hi" } })
      )
    ).toHaveLength(0);
  });

  it("ignores an attachment-only message with no text", () => {
    expect(
      discovery.parseEvents(
        messaging({ sender: { id: "user_777" }, message: { mid: "m1" } })
      )
    ).toHaveLength(0);
  });

  it("parses a postback from a button tap", () => {
    const events = discovery.parseEvents(
      messaging({
        sender: { id: "user_777" },
        postback: { mid: "p1", payload: "reveal:camp_1" },
      })
    );
    expect(events[0]).toMatchObject({
      kind: "postback",
      platform: "FACEBOOK",
      userId: "user_777",
      payload: "reveal:camp_1",
    });
  });
});

describe("facebook adapter — capabilities", () => {
  it("cannot follow-gate, because Pages have no follow-status API", () => {
    expect(supports("FACEBOOK", "FOLLOW_GATE")).toBe(false);
    expect(messaging.checkFollowStatus).toBeUndefined();
  });

  it("can pre-flight reply eligibility, which Instagram cannot", () => {
    expect(supports("FACEBOOK", "PREFLIGHT_REPLY_ELIGIBILITY")).toBe(true);
    expect(messaging.checkReplyEligibility).toBeTypeOf("function");
    expect(supports("INSTAGRAM", "PREFLIGHT_REPLY_ELIGIBILITY")).toBe(false);
  });

  it("keeps the 7-day reply window distinct from Instagram's 24 hours", () => {
    expect(PRIVATE_REPLY_WINDOW_HOURS.FACEBOOK).toBe(168);
    expect(PRIVATE_REPLY_WINDOW_HOURS.INSTAGRAM).toBe(24);
  });
});
