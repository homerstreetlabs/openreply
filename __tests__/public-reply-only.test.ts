import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Platforms with no messaging API.
 *
 * `processComment` used to return the moment `adapter.messaging` was null,
 * which is every YouTube and TikTok comment. The poll sweep and the TikTok
 * webhook both enqueue those jobs, so the one capability those platforms have
 * was unreachable in production while every adapter unit test passed.
 */

const { mockPrisma, mockDecryptToken, mockMatchKeywords, mockPostPublicReply } =
  vi.hoisted(() => ({
    mockPrisma: {
      campaign: { findMany: vi.fn() },
      responseRun: {
        findUnique: vi.fn(),
        update: vi.fn(),
        create: vi.fn(),
        upsert: vi.fn(),
      },
      operationalEvent: { create: vi.fn() },
    },
    mockDecryptToken: vi.fn(),
    mockMatchKeywords: vi.fn(),
    mockPostPublicReply: vi.fn(),
  }));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mockDecryptToken }));
vi.mock("@/lib/utils/keyword-matcher", () => ({ matchKeywords: mockMatchKeywords }));
vi.mock("@/lib/utils/rate-limiter", () => ({ reserveDMSlot: vi.fn() }));
vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: vi.fn(),
  releaseWorkspaceDMReservation: vi.fn(),
}));
vi.mock("@/lib/ops/worker-health", () => ({ recordWorkerAlert: vi.fn() }));
vi.mock("@/lib/queue/client", () => ({
  enqueue: vi.fn(),
  requeue: vi.fn(),
  COMMENT_JOB_NAME: "process-comment",
  POSTBACK_JOB_NAME: "process-postback",
  FOLLOWUP_JOB_NAME: "process-followup",
  MESSAGE_JOB_NAME: "process-message",
}));

vi.mock("@/lib/platforms/registry", () => ({
  adapterFor: () => ({
    platform: "YOUTUBE",
    capabilities: ["PUBLIC_REPLY"],
    discovery: { kind: "poll", pollCost: 1 },
    messaging: null,
    postPublicReply: mockPostPublicReply,
    listPosts: vi.fn(),
  }),
  pollOnlyPlatforms: () => ["YOUTUBE"],
}));

import { processJob } from "../lib/queue/dm-worker";

const campaign = {
  id: "camp_yt",
  name: "Shorts replies",
  workspaceId: "ws_1",
  connectedAccountId: "acct_row_1",
  postId: "video_1",
  keywords: ["LINK"],
  dmMessage: "",
  isActive: true,
  wholeWordMatch: true,
  matchAnyPost: false,
  matchAnyWord: false,
  openingDmEnabled: false,
  openingDmMessage: null,
  openingDmButtonLabel: null,
  linkButtonLabel: null,
  publicReplyEnabled: true,
  publicReplyMessage: null,
  publicReplyMessages: ["sent it your way, check the pinned comment"],
  connectedAccount: {
    id: "acct_row_1",
    instagramId: "channel_1",
    accessToken: "encrypted",
  },
  workspace: { id: "ws_1" },
  trackedLinks: [],
};

const job = {
  name: "process-comment",
  id: "j1",
  attemptsMade: 0,
  data: {
    platform: "YOUTUBE" as const,
    instagramAccountId: "channel_1",
    commentId: "c_1",
    commentText: "LINK please",
    commenterId: "viewer_1",
    commenterName: "viewer",
    mediaId: "video_1",
  },
};

const run = processJob as unknown as (j: typeof job) => Promise<void>;

beforeEach(() => {
  vi.clearAllMocks();
  mockDecryptToken.mockReturnValue("plaintext");
  mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
  mockPrisma.campaign.findMany.mockResolvedValue([campaign]);
  mockPrisma.responseRun.findUnique.mockResolvedValue(null);
  mockPrisma.responseRun.create.mockResolvedValue({});
  mockPrisma.responseRun.update.mockResolvedValue({});
  mockPostPublicReply.mockResolvedValue({ id: "reply_1" });
});

describe("a comment on a platform that cannot message", () => {
  it("posts the public reply", async () => {
    await run(job);

    expect(mockPostPublicReply).toHaveBeenCalledWith(
      "plaintext",
      "channel_1",
      "c_1",
      "sent it your way, check the pinned comment"
    );
  });

  it("settles the run rather than leaving it pending", async () => {
    await run(job);

    const settle = mockPrisma.responseRun.update.mock.calls.at(-1)?.[0];
    expect(settle.data.status).toBe("SENT");
  });

  it("fails the run when the platform's only capability is not configured", async () => {
    mockPrisma.campaign.findMany.mockResolvedValue([
      { ...campaign, publicReplyEnabled: false },
    ]);

    await run(job);

    expect(mockPostPublicReply).not.toHaveBeenCalled();
    const settle = mockPrisma.responseRun.update.mock.calls.at(-1)?.[0];
    expect(settle.data.status).toBe("FAILED");
    expect(settle.data.errorMessage).toContain("YouTube");
  });

  it("reports the platform error when the reply is refused", async () => {
    mockPostPublicReply.mockRejectedValue(new Error("quotaExceeded"));

    await run(job);

    const settle = mockPrisma.responseRun.update.mock.calls.at(-1)?.[0];
    expect(settle.data.status).toBe("FAILED");
    expect(settle.data.errorMessage).toContain("quotaExceeded");
  });
});
