import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";

const enqueue = vi.fn();

vi.mock("@/lib/queue/client", () => ({
  COMMENT_JOB_NAME: "process-comment",
  enqueue: (...args: unknown[]) => enqueue(...args),
}));

const findAccount = vi.fn();
const listRecentComments = vi.fn();

vi.mock("@/lib/db/client", () => ({
  prisma: {
    webhookEvent: { create: vi.fn().mockResolvedValue({}) },
    connectedAccount: { findUnique: (...args: unknown[]) => findAccount(...args) },
  },
}));

vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "plaintext" }));

vi.mock("@/lib/platforms/tiktok", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platforms/tiktok")>();
  return {
    ...actual,
    tiktokAdapter: {
      ...actual.tiktokAdapter,
      listRecentComments: (...args: unknown[]) => listRecentComments(...args),
    },
  };
});

const SECRET = "tiktok_test_secret";

/**
 * TikTok's signing scheme is undocumented, so the route re-reads the comment
 * from the API before acting. A delivery whose comment the API does not report
 * is dropped, which is what a forged payload would look like.
 */
function commentExists(text = "where can I buy this") {
  findAccount.mockResolvedValue({ accessToken: "encrypted" });
  listRecentComments.mockResolvedValue([
    {
      id: "7300000000000000001",
      postId: "7200000000000000002",
      text,
      authorId: "commenter_uid",
      authorName: "A Commenter",
      createdAtMs: null,
      ownerHasReplied: false,
    },
  ]);
}

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

function commentBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: "comment.update",
    user_openid: "creator_open_id",
    content: JSON.stringify({
      comment_id: "7300000000000000001",
      comment_action: "insert",
      video_id: "7200000000000000002",
      text: "where can I buy this",
      unique_identifier: "commenter_uid",
      nickname: "A Commenter",
    }),
    ...overrides,
  });
}

async function post(body: string, signature: string | null) {
  const { POST } = await import("../app/api/webhook/tiktok/route");
  const headers = new Headers();
  if (signature !== null) headers.set("tiktok-signature", signature);
  return POST(new Request("https://x/api/webhook/tiktok", { method: "POST", body, headers }) as never);
}

beforeEach(() => {
  enqueue.mockReset();
  vi.stubEnv("TIKTOK_WEBHOOK_SECRET", SECRET);
});

afterEach(() => vi.unstubAllEnvs());

describe("tiktok webhook route", () => {
  it("enqueues a comment for a correctly signed delivery", async () => {
    commentExists();
    const body = commentBody();
    const response = await post(body, sign(body));

    expect(response.status).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);

    const [job, payload] = enqueue.mock.calls[0];
    expect(job).toBe("process-comment");
    expect(payload).toMatchObject({
      platform: "TIKTOK",
      commentId: "7300000000000000001",
      commenterId: "commenter_uid",
      source: "WEBHOOK",
    });
  });

  it("rejects a body whose signature does not match", async () => {
    const response = await post(commentBody(), sign("something else"));

    expect(response.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  /**
   * TikTok does not document the signing scheme, so an unconfigured secret must
   * reject rather than wave deliveries through. Anyone who learns the URL could
   * otherwise enqueue sends against any connected account.
   */
  it("rejects everything while the secret is unset", async () => {
    vi.stubEnv("TIKTOK_WEBHOOK_SECRET", "");
    const body = commentBody();
    const response = await post(body, sign(body));

    expect(response.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("answers 200 without enqueuing for an event it does not handle", async () => {
    const body = JSON.stringify({ event: "video.publish", user_openid: "creator_open_id" });
    const response = await post(body, sign(body));

    expect(response.status).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  /** A deleted comment must not trigger a reply to a comment that is gone. */
  it("ignores a comment action other than insert", async () => {
    const body = commentBody({
      content: JSON.stringify({
        comment_id: "7300000000000000009",
        comment_action: "delete",
        video_id: "7200000000000000002",
        text: "gone",
        unique_identifier: "commenter_uid",
      }),
    });
    const response = await post(body, sign(body));

    expect(response.status).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("re-reading before acting, while the signing scheme is unverified", () => {
  it("drops a delivery whose comment the API does not report", async () => {
    findAccount.mockResolvedValue({ accessToken: "encrypted" });
    listRecentComments.mockResolvedValue([]);

    const body = commentBody();
    const response = await post(body, sign(body));

    expect(response.status).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("drops a delivery for an account this instance does not hold", async () => {
    findAccount.mockResolvedValue(null);

    const body = commentBody();
    await post(body, sign(body));

    expect(enqueue).not.toHaveBeenCalled();
  });

  /**
   * A forged body could otherwise choose which keyword it matched, so the text
   * that reaches the engine is TikTok's, not the payload's.
   */
  it("uses the text the API reports, not the text the payload claimed", async () => {
    commentExists("the real comment text");

    const body = commentBody();
    await post(body, sign(body));

    expect(enqueue.mock.calls[0][1]).toMatchObject({
      commentText: "the real comment text",
    });
  });
});
