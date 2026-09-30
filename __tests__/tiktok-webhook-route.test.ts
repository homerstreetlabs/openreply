import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";

const enqueue = vi.fn();

vi.mock("@/lib/queue/client", () => ({
  COMMENT_JOB_NAME: "process-comment",
  enqueue: (...args: unknown[]) => enqueue(...args),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: { webhookEvent: { create: vi.fn().mockResolvedValue({}) } },
}));

const SECRET = "tiktok_test_secret";

function sign(body: string): string {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},s=${createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")}`;
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
   * An unconfigured secret must reject rather than wave deliveries through.
   * Anyone who learns the URL could otherwise enqueue sends against any
   * connected account.
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

describe("acting on a verified delivery", () => {
  /**
   * TikTok delivers the webhook before the comment appears in its comment list,
   * so a confirming read dropped every real comment.
   */
  it("enqueues the comment the payload carries, text included", async () => {
    const body = commentBody();
    await post(body, sign(body));

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][1]).toMatchObject({
      commentText: "where can I buy this",
      mediaId: "7200000000000000002",
    });
  });

  it("ignores a threaded reply, which includes the account's own replies", async () => {
    const body = commentBody({
      content: JSON.stringify({
        comment_id: "7300000000000000010",
        parent_comment_id: "7300000000000000001",
        comment_type: "reply",
        comment_action: "insert",
        video_id: "7200000000000000002",
        text: "thanks for asking",
        unique_identifier: "creator_uid",
      }),
    });
    await post(body, sign(body));

    expect(enqueue).not.toHaveBeenCalled();
  });
});
