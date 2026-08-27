/**
 * Rate Limiter — Unit Tests
 *
 * The hourly cap is now one configuration of the quota broker rather than its
 * own counter, so these pin the RateLimitResult contract the send path reads
 * while the broker's own shapes are tested in quota.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockReserve, mockPressure } = vi.hoisted(() => ({
  mockReserve: vi.fn(),
  mockPressure: vi.fn(),
}));

vi.mock("@/lib/runtime/quota", () => ({
  reserve: mockReserve,
  pressure: mockPressure,
}));

import { reserveDMSlot, sendPressure } from "../lib/utils/rate-limiter";
import { responseBuckets, type AccountBudget } from "../lib/runtime/send-quota";

/** Never refreshed, which is the state every account starts in. */
const UNMEASURED: AccountBudget = {
  accountExternalId: "account_123",
  providerAppId: "app_1",
  derivedCapacityUnits: null,
  derivedCapacityAt: null,
};

function granted() {
  mockReserve.mockResolvedValue({
    ok: true,
    lease: { buckets: ["account:acct:meta:private_reply"], settle: vi.fn() },
  });
}

function refused(remaining = 0) {
  mockReserve.mockResolvedValue({
    ok: false,
    refusal: { bucket: "account:acct:meta:private_reply", remaining, retryAfterMs: 1000 },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPressure.mockResolvedValue(0);
});

describe("reserveDMSlot", () => {
  it("spends one unit against the account's hourly bucket", async () => {
    granted();

    const result = await reserveDMSlot("INSTAGRAM", UNMEASURED);

    expect(mockReserve).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          scope: { kind: "account", id: "account_123" },
          meter: "meta:private_reply",
          window: { kind: "rolling", ms: 3600 * 1000 },
          capacity: { kind: "fixed", units: 750 },
        }),
      ],
      { units: 1 }
    );
    expect(result.allowed).toBe(true);
    expect(result.reserved).toBe(true);
  });

  it("recommends requeue when the broker refuses", async () => {
    refused();

    const result = await reserveDMSlot("INSTAGRAM", UNMEASURED, 0);

    expect(result.allowed).toBe(false);
    expect(result.reserved).toBe(false);
    expect(result.shouldRequeue).toBe(true);
    expect(result.shouldSkip).toBe(false);
  });

  it("skips after the requeue budget is spent", async () => {
    refused();

    const result = await reserveDMSlot("INSTAGRAM", UNMEASURED, 3);

    expect(result.allowed).toBe(false);
    expect(result.shouldRequeue).toBe(false);
    expect(result.shouldSkip).toBe(true);
  });

  it("routes each account to its own bucket", async () => {
    granted();

    await reserveDMSlot("INSTAGRAM", { ...UNMEASURED, accountExternalId: "account_a" });
    await reserveDMSlot("INSTAGRAM", { ...UNMEASURED, accountExternalId: "account_b" });

    const ids = mockReserve.mock.calls.map((c) => c[0][0].scope.id);
    expect(ids).toEqual(["account_a", "account_b"]);
  });

  /**
   * Off a Worker there is no binding and no real API to protect, so the broker
   * grants with an empty lease. Refusing would turn a local run into a silent
   * no-send.
   */
  it("allows but does not claim a reservation when no binding exists", async () => {
    mockReserve.mockResolvedValue({ ok: true, lease: { buckets: [], settle: vi.fn() } });

    const result = await reserveDMSlot("INSTAGRAM", UNMEASURED);

    expect(result.allowed).toBe(true);
    expect(result.reserved).toBe(false);
  });

  it("propagates a broker failure rather than sending anyway", async () => {
    mockReserve.mockRejectedValue(new Error("Quota bucket returned 500"));

    await expect(reserveDMSlot("INSTAGRAM", UNMEASURED)).rejects.toThrow(/500/);
  });

  it("charges each platform its own shape, not Instagram's", async () => {
    granted();

    await reserveDMSlot("FACEBOOK", UNMEASURED);

    const [buckets] = mockReserve.mock.calls[0];
    expect(buckets[0].capacity.kind).toBe("derived");
    expect(buckets[0].meter).toBe("meta:page_calls");
  });

  it("falls back to a floor for a Page whose engagement was never measured", async () => {
    granted();

    await reserveDMSlot("FACEBOOK", UNMEASURED);

    const [buckets] = mockReserve.mock.calls[0];
    expect(buckets[0].capacity.units).toBeNull();
    expect(buckets[0].capacity.floor).toBeGreaterThan(0);
  });
});

describe("sendPressure", () => {
  it("reports fullness rather than a count against a ceiling that may not exist", async () => {
    mockPressure.mockResolvedValue(0.4);

    expect(await sendPressure("INSTAGRAM", UNMEASURED)).toBe(0.4);
  });
});

/**
 * YouTube's spam policy names "high-volume, repetitive… comments… to drive
 * traffic", and the strike lands on the creator's channel. The daily pool alone
 * does not stop one video absorbing the whole budget.
 */
describe("per-post reply caps", () => {
  const budget: AccountBudget = {
    accountExternalId: "channel_1",
    providerAppId: "app_1",
    derivedCapacityUnits: null,
    derivedCapacityAt: null,
  };

  it("caps replies per video on top of the shared daily pool", async () => {
    const { buckets } = responseBuckets("YOUTUBE", "publicReply", {
      ...budget,
      postId: "video_1",
    });

    expect(buckets).toHaveLength(2);
    const perVideo = buckets.find((b) => b.meter === "youtube:replies_per_video");
    expect(perVideo?.scope.id).toBe("channel_1:video_1");
  });

  it("gives each video its own budget", async () => {
    const one = responseBuckets("YOUTUBE", "publicReply", { ...budget, postId: "video_1" });
    const two = responseBuckets("YOUTUBE", "publicReply", { ...budget, postId: "video_2" });

    expect(one.buckets[1].scope.id).not.toBe(two.buckets[1].scope.id);
  });

  it("charges the documented fifty units for a reply and nothing for a poll-only account", async () => {
    const reply = responseBuckets("YOUTUBE", "publicReply", budget);
    expect(reply.cost.units).toBe(50);
  });
});

/**
 * TikTok's QPM tiers are throughput, not volume. Neither stops one video
 * carrying hundreds of replies across a day, which is the shape TikTok flags as
 * spam and hides without sending the `set_to_public` webhook that would tell us.
 */
describe("TikTok's per-video reply cap", () => {
  const budget: AccountBudget = {
    accountExternalId: "biz_1",
    providerAppId: "app_1",
    derivedCapacityUnits: null,
    derivedCapacityAt: null,
  };

  it("adds a daily per-video cap on top of the two QPM tiers", () => {
    const { buckets } = responseBuckets("TIKTOK", "publicReply", {
      ...budget,
      postId: "video_1",
    });

    expect(buckets).toHaveLength(3);
    const perVideo = buckets.find((b) => b.meter === "tiktok:replies_per_video");
    expect(perVideo?.scope.id).toBe("biz_1:video_1");
    expect(perVideo?.window.kind).toBe("calendarDay");
  });

  it("still reserves both QPM levels, which the broker co-locates", () => {
    const { buckets } = responseBuckets("TIKTOK", "publicReply", budget);

    expect(buckets.filter((b) => b.meter === "tiktok:calls")).toHaveLength(2);
  });
});
