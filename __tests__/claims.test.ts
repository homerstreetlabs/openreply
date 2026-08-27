import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    deliveryClaim: {
      updateMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  acquireClaims,
  classifyAttempt,
  releaseClaims,
  releaseIfUnattempted,
  settleClaims,
  type ExclusiveClaim,
} from "../lib/runtime/claims";

const REPLY: ExclusiveClaim = {
  scope: "ig:private_reply",
  key: "comment_1",
};

/**
 * Whether a claim was released, as opposed to swept.
 *
 * Both are deletes. A release is scoped to the run that took the claim; the
 * lapsed-lease sweep is scoped by deadline and runs on every acquire, so
 * counting calls would no longer distinguish them.
 */
function released(): boolean {
  return mockPrisma.deliveryClaim.deleteMany.mock.calls.some(
    (call: unknown[]) =>
      (call[0] as { where?: { runKey?: string } } | undefined)?.where?.runKey !== undefined
  );
}

/** What Postgres raises when the unique index rejects a second holder. */
function uniqueViolation() {
  return new Error("Unique constraint failed on the fields: (`scope`,`key`)");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.deliveryClaim.create.mockResolvedValue({});
  mockPrisma.deliveryClaim.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.deliveryClaim.updateMany.mockResolvedValue({ count: 1 });
});

describe("acquireClaims", () => {
  it("holds an empty claim list without touching the ledger", async () => {
    const result = await acquireClaims([], "camp_1", "run_1");

    expect(result.held).toBe(true);
    expect(mockPrisma.deliveryClaim.create).not.toHaveBeenCalled();
  });

  it("grants the claim to the first caller", async () => {
    const result = await acquireClaims([REPLY], "camp_1", "run_1");

    expect(result).toMatchObject({ held: true });
    expect(mockPrisma.deliveryClaim.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scope: "ig:private_reply",
          key: "comment_1",
          campaignId: "camp_1",
          runKey: "run_1",
        }),
      })
    );
  });

  it("refuses the second caller and names who holds it", async () => {
    mockPrisma.deliveryClaim.create.mockRejectedValue(uniqueViolation());
    mockPrisma.deliveryClaim.findUnique.mockResolvedValue({
      runKey: "run_1",
      campaignId: "camp_1",
      campaign: { name: "first campaign" },
    });

    const result = await acquireClaims([REPLY], "camp_2", "run_2");

    expect(result).toMatchObject({
      held: false,
      holderCampaignId: "camp_1",
      holderCampaignName: "first campaign",
    });
  });

  /**
   * Cloudflare Queues delivers at least once and has no dedup key, so the same
   * comment reaches the send path more than once as a matter of course.
   */
  it("is idempotent when the same run re-acquires its own claim", async () => {
    mockPrisma.deliveryClaim.create.mockRejectedValue(uniqueViolation());
    mockPrisma.deliveryClaim.findUnique.mockResolvedValue({
      runKey: "run_1",
      campaignId: "camp_1",
      campaign: { name: "same campaign" },
    });

    const result = await acquireClaims([REPLY], "camp_1", "run_1");

    expect(result.held).toBe(true);
    expect(released()).toBe(false);
  });

  it("takes all claims or none", async () => {
    const second: ExclusiveClaim = { ...REPLY, key: "comment_2" };
    mockPrisma.deliveryClaim.create
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(uniqueViolation());
    mockPrisma.deliveryClaim.findUnique.mockResolvedValue({
      runKey: "other_run",
      campaignId: "other_camp",
      campaign: { name: "other" },
    });

    const result = await acquireClaims([REPLY, second], "camp_1", "run_1");

    expect(result.held).toBe(false);
    expect(mockPrisma.deliveryClaim.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          runKey: "run_1",
          OR: [{ scope: REPLY.scope, key: REPLY.key }],
        }),
      })
    );
  });

  it("does not release the winner's claim when it loses", async () => {
    mockPrisma.deliveryClaim.create.mockRejectedValue(uniqueViolation());
    mockPrisma.deliveryClaim.findUnique.mockResolvedValue({
      runKey: "winner_run",
      campaignId: "winner",
      campaign: { name: "winner" },
    });

    await acquireClaims([REPLY], "loser", "loser_run");

    expect(released()).toBe(false);
  });
});

describe("releaseClaims", () => {
  it("scopes the delete to the run that took it", async () => {
    await releaseClaims([REPLY], "run_1");

    expect(mockPrisma.deliveryClaim.deleteMany).toHaveBeenCalledWith({
      where: { runKey: "run_1", OR: [{ scope: REPLY.scope, key: REPLY.key }] },
    });
  });

  it("does nothing for an empty list", async () => {
    await releaseClaims([], "run_1");
    expect(mockPrisma.deliveryClaim.deleteMany).not.toHaveBeenCalled();
  });
});

/**
 * The direction of error here is the whole point. Over-holding costs one lost
 * send. Releasing wrongly lets a second campaign burn an API call on a comment
 * the platform will never accept another reply for.
 */
describe("releaseIfUnattempted", () => {
  it("releases only when the platform provably did not act", async () => {
    await releaseIfUnattempted([REPLY], "run_1", "no");
    expect(mockPrisma.deliveryClaim.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("holds the claim when the outcome is unknown", async () => {
    await releaseIfUnattempted([REPLY], "run_1", "unknown");
    expect(mockPrisma.deliveryClaim.deleteMany).not.toHaveBeenCalled();
  });

  it("holds the claim when the platform did act", async () => {
    await releaseIfUnattempted([REPLY], "run_1", "yes");
    expect(mockPrisma.deliveryClaim.deleteMany).not.toHaveBeenCalled();
  });
});

/**
 * A claim is a lease until the send is confirmed. Holding one forever on an
 * unknown outcome forfeits the comment's only reply for a send that may never
 * have happened, and a process that dies between taking the claim and sending
 * leaves no error to classify at all.
 */
describe("the unsettled lease", () => {
  it("takes the claim with a deadline rather than permanently", async () => {
    await acquireClaims([REPLY], "camp_1", "run_1");

    const created = mockPrisma.deliveryClaim.create.mock.calls[0][0];
    expect(created.data.reclaimableAt).toBeInstanceOf(Date);
    expect(created.data.reclaimableAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("clears a lapsed lease before trying to take the claim", async () => {
    await acquireClaims([REPLY], "camp_1", "run_1");

    const sweep = mockPrisma.deliveryClaim.deleteMany.mock.calls[0][0];
    expect(sweep.where.reclaimableAt.not).toBeNull();
    expect(sweep.where.reclaimableAt.lte).toBeInstanceOf(Date);
  });

  it("settles the claim forever once the platform has acted", async () => {
    await settleClaims([REPLY], "run_1");

    const settled = mockPrisma.deliveryClaim.updateMany.mock.calls[0][0];
    expect(settled.data.reclaimableAt).toBeNull();
    expect(settled.where.runKey).toBe("run_1");
  });

  it("settles nothing for a platform that consumes no claims", async () => {
    await settleClaims([], "run_1");
    expect(mockPrisma.deliveryClaim.updateMany).not.toHaveBeenCalled();
  });
});

describe("classifyAttempt", () => {
  it.each([
    ["Hourly DM rate limit reached for this account", "no"],
    ["Failed to decrypt the stored access token", "no"],
    ["No access token available for this account", "no"],
    ["Cloudflare bindings are unavailable", "no"],
  ])("treats %s as never reaching the platform", (message, expected) => {
    expect(classifyAttempt(new Error(message))).toBe(expected);
  });

  /**
   * A rejected button template already reached Meta, which spent the comment's
   * one allowed reply. Treating it as unattempted is the mistake this guards.
   */
  it.each([
    "The comment is invalid for a private reply",
    "outside of allowed window",
    "Meta API Error 190: token expired",
    "something nobody has seen before",
  ])("treats %s as possibly delivered", (message) => {
    expect(classifyAttempt(new Error(message))).toBe("unknown");
  });

  it("treats a non-Error rejection as possibly delivered", () => {
    expect(classifyAttempt("a bare string")).toBe("unknown");
  });
});
